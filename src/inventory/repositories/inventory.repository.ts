import { Injectable } from '@nestjs/common';
import type { Inventory, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * The exact columns `InventoryRepository.create` is allowed to write.
 *
 * `id`, `createdAt` and `updatedAt` are absent because they are database-owned
 * and must never be reachable from a request payload.
 *
 * `variantId` is present because inventory cannot exist without an owner; the
 * service always fills it from the URL rather than from the body.
 *
 * `quantity` and `reservedQuantity` are required here — the service applies the
 * zero defaults before calling — so the repository never has to decide what an
 * omitted counter means.
 */
export interface CreateInventoryData {
  variantId: string;
  quantity: number;
  reservedQuantity: number;
}

/**
 * The subset of columns a `PATCH` may write. Absent keys are left untouched, so
 * a request that changes only `quantity` does not also rewrite
 * `reservedQuantity` (and vice versa).
 *
 * `variantId` is missing on purpose: ownership is fixed at creation, so no public
 * write can move an inventory row to another variant.
 */
export interface UpdateInventoryData {
  quantity?: number;
  reservedQuantity?: number;
}

/**
 * A Prisma client bound to an interactive transaction.
 *
 * Repository methods accept one so the service can run a read followed by a
 * write against the *same* connection and transaction. That is what makes a
 * read-modify-write sequence atomic instead of racing another writer between the
 * two statements.
 */
export type InventoryTransactionClient = Prisma.TransactionClient;

/**
 * The only place in the inventory feature that talks to the database.
 *
 * It owns Inventory persistence and nothing else: no ownership reasoning, no
 * invariant reasoning, no exception mapping, no DTO mapping, no HTTP status
 * decisions.
 *
 * ## Transactional mutations
 *
 * {@link runInTransaction} is the primitive every stock mutation goes through.
 * The read and the write of a read-modify-write sequence execute on one
 * transaction, so another writer cannot slip between them, and the
 * `CHECK` constraints on the table are the backstop: a write that would persist
 * `reserved_quantity > quantity` (or a negative counter) is rejected by the
 * database itself, regardless of how many writers interleave.
 *
 * ## Reserving stock
 *
 * {@link reserve} is the only method here that both reads and writes a counter in
 * one statement, and it exists because checkout cannot afford to do it in two. It
 * is the sole path by which a customer's intent to buy turns into a hold on stock,
 * so it is deliberately the *only* one: a second, differently-shaped reservation
 * method would be a second place for the rule to be wrong.
 */
@Injectable()
export class InventoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `work` in a single interactive transaction and hands it a client bound
   * to that transaction. Use it for every read-modify-write stock mutation.
   */
  runInTransaction<T>(
    work: (tx: InventoryTransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(work);
  }

  /** Persists a new inventory row and returns the stored entity. */
  create(
    data: CreateInventoryData,
    client: InventoryTransactionClient = this.prisma,
  ): Promise<Inventory> {
    return client.inventory.create({ data });
  }

  /**
   * Returns the single inventory row for `variantId`, or `null` when the variant
   * has none.
   *
   * `variantId` is unique, so `findUnique` addresses the row directly and the
   * lookup is scoped to its owner without a join.
   */
  findByVariantId(
    variantId: string,
    client: InventoryTransactionClient = this.prisma,
  ): Promise<Inventory | null> {
    return client.inventory.findUnique({ where: { variantId } });
  }

  /**
   * Returns the inventory rows for `variantIds` in one query.
   *
   * The order-level release and commit operations need to know which variants have
   * no inventory row at all *before* they start moving counters, so they can fail
   * fast on a missing row instead of discovering it halfway through a multi-line
   * order. One `IN` query does that for the whole order; a lookup per line would be
   * N+1 and would still need the same validation.
   *
   * An unknown id is simply absent from the result. The caller decides what that
   * means; this repository method does not invent a row.
   */
  findByVariantIds(
    variantIds: string[],
    client: InventoryTransactionClient = this.prisma,
  ): Promise<Inventory[]> {
    if (variantIds.length === 0) {
      return Promise.resolve([]);
    }

    return client.inventory.findMany({
      where: { variantId: { in: variantIds } },
    });
  }

  /**
   * Writes only the counters present in `data`, so an update can never
   * accidentally overwrite the other counter with an undefined value.
   *
   * The primary key is a server-generated UUID and `variantId` is unique, so the
   * row is addressed by `variantId`. Rejects with Prisma's `P2025` when no row
   * exists, or with a constraint error when the resulting counters violate the
   * table's `CHECK` constraints; the service resolves ownership first so the
   * former maps to a 404 and translates the latter.
   */
  update(
    variantId: string,
    data: UpdateInventoryData,
    client: InventoryTransactionClient = this.prisma,
  ): Promise<Inventory> {
    return client.inventory.update({ where: { variantId }, data });
  }

  /**
   * Atomically reserves `quantity` units of `variantId`, and returns how many rows
   * changed: `1` when the hold was taken, `0` when it was refused.
   *
   * This is the single most important method in the inventory feature, and it is one
   * statement on purpose.
   *
   * ## Why not read, then write
   *
   * The obvious implementation reads `available = quantity - reservedQuantity`,
   * checks the request against it, and writes back the sum. That is unsafe, and not
   * because of a subtle bug: with stock 5 and two concurrent requests for 4 and 3,
   * *both* read `available = 5`, *both* pass their check, and *both* write — leaving
   * `reserved_quantity = 7` on a row that holds 5. No amount of care inside the
   * application prevents it, because the interleaving happens between the two
   * statements.
   *
   * ## What makes this safe
   *
   * The guard and the increment are the same statement, so PostgreSQL evaluates the
   * predicate against the row it has locked:
   *
   * ```sql
   * UPDATE inventory
   *    SET reserved_quantity = reserved_quantity + n
   *  WHERE variant_id = $1
   *    AND quantity - reserved_quantity >= n
   * ```
   *
   * Under `READ COMMITTED` the second writer to reach the row blocks on the lock,
   * then re-evaluates the predicate against the *newly committed* row (`EvalPlanQual`).
   * It sees the first writer's increment, fails the guard, and changes nothing.
   * Exactly one of any number of concurrent reservations can win, no matter how they
   * interleave — the loser learns it lost from the `0`, not from a guess.
   *
   * ## Why raw SQL rather than `updateMany`
   *
   * Because Prisma's query API cannot express the guard. `where` filters columns
   * against *constants*, never against each other, so "this row's own `quantity`
   * minus its own `reservedQuantity` is at least `n`" is not expressible there.
   * Emulating it — `updateMany({ where: { reservedQuantity: { lte: available - n } } })`
   * with `available` read beforehand — reintroduces exactly the read-then-write race
   * this method exists to remove. The statement is therefore written out, and it is
   * the only raw SQL in the feature.
   *
   * ## Why `quantity` is never written
   *
   * Only `reserved_quantity` appears in the `SET` clause. Reserving stock does not
   * change how much of it there is; the two counters mean different things, and
   * `quantity` is owned by stock movements. `updated_at` is set explicitly because
   * Prisma's `@updatedAt` is applied client-side, which raw SQL does not get.
   *
   * The table's `CHECK (reserved_quantity <= quantity)` is the backstop that makes
   * `reserved_quantity > quantity` unrepresentable even if this predicate were
   * somehow wrong.
   *
   * @param variantId The variant to hold stock for.
   * @param quantity Whole units to reserve; callers reject `0` and negatives before
   *   getting here, since neither is a meaningful hold.
   * @returns `1` if the hold was taken, `0` if the variant has no inventory row or
   *   the guard rejected it.
   */
  reserve(
    variantId: string,
    quantity: number,
    client: InventoryTransactionClient = this.prisma,
  ): Promise<number> {
    return client.$executeRaw`
      UPDATE "inventory"
         SET "reserved_quantity" = "reserved_quantity" + ${quantity},
             "updated_at" = now()
       WHERE "variant_id" = ${variantId}::uuid
         AND "quantity" - "reserved_quantity" >= ${quantity}
    `;
  }

  /**
   * Atomically releases `quantity` units of a variant's reservation, returning how
   * many rows changed: `1` when the release happened, `0` when it was refused.
   *
   * The mirror image of {@link reserve}. The guard and the decrement are the same
   * statement, so PostgreSQL evaluates `reserved_quantity >= n` against the row it
   * has locked and a concurrent release cannot drive the counter below zero:
   *
   * ```sql
   * UPDATE inventory
   *    SET reserved_quantity = reserved_quantity - n
   *  WHERE variant_id = $1
   *    AND reserved_quantity >= n
   * ```
   *
   * `quantity` is untouched because releasing a hold does not change how much stock
   * physically exists. A `0` means either "no such inventory row" or "not that much
   * is reserved"; the caller distinguishes the two with a read, exactly as checkout
   * distinguishes "not stocked" from "not enough". The guarded update remains the
   * authoritative decision in both cases.
   *
   * `updated_at` is set explicitly because Prisma's `@updatedAt` is client-side and
   * raw SQL does not receive it. Negative and zero quantities are rejected before
   * the statement: without that, `reserved_quantity >= -n` would match every row and
   * a negative `n` would *increase* the reservation.
   */
  async releaseReserved(
    variantId: string,
    quantity: number,
    client: InventoryTransactionClient = this.prisma,
  ): Promise<number> {
    assertPositiveWholeUnits(quantity);

    return client.$executeRaw`
      UPDATE "inventory"
         SET "reserved_quantity" = "reserved_quantity" - ${quantity},
             "updated_at" = now()
       WHERE "variant_id" = ${variantId}::uuid
         AND "reserved_quantity" >= ${quantity}
    `;
  }

  /**
   * Atomically commits `quantity` reserved units when stock leaves the warehouse,
   * returning how many rows changed: `1` when the commitment happened, `0` when it
   * was refused.
   *
   * A shipment consumes both counters, so both are decremented in the same guarded
   * statement:
   *
   * ```sql
   * UPDATE inventory
   *    SET quantity = quantity - n,
   *        reserved_quantity = reserved_quantity - n
   *  WHERE variant_id = $1
   *    AND quantity >= n
   *    AND reserved_quantity >= n
   * ```
   *
   * Requiring both guards is what makes negative counters unrepresentable even if
   * the two values were inconsistent before the write, and the table's
   * `CHECK (reserved_quantity <= quantity)` remains the final backstop. Nothing is
   * clamped or repaired: a row that cannot satisfy the guards is left exactly as it
   * was and the caller receives `0`.
   *
   * A row with a coherent pair (`reserved_quantity <= quantity`) cannot have
   * `reserved_quantity >= n` and `quantity < n`, so the second guard is defence in
   * depth rather than a state the normal ledger can reach. It still belongs in the
   * statement: the database must refuse a physically impossible commitment, not
   * assume an invariant held a moment earlier.
   *
   * Negative and zero quantities are rejected before the statement, because a
   * negative `n` would otherwise *increase* both counters.
   */
  async commitReserved(
    variantId: string,
    quantity: number,
    client: InventoryTransactionClient = this.prisma,
  ): Promise<number> {
    assertPositiveWholeUnits(quantity);

    return client.$executeRaw`
      UPDATE "inventory"
         SET "quantity" = "quantity" - ${quantity},
             "reserved_quantity" = "reserved_quantity" - ${quantity},
             "updated_at" = now()
       WHERE "variant_id" = ${variantId}::uuid
         AND "quantity" >= ${quantity}
         AND "reserved_quantity" >= ${quantity}
    `;
  }
}

/**
 * Rejects a stock movement that is not a positive whole number of units.
 *
 * The guarded statements are arithmetic on the stored counters, so a zero would be
 * a no-op that still reports a changed row, a fraction would not fit the integer
 * columns, and a negative value would invert the movement. All three are programmer
 * errors rather than business conflicts, so they fail before any SQL is issued.
 */
function assertPositiveWholeUnits(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new RangeError(
      'Stock movement quantity must be a positive whole number',
    );
  }
}
