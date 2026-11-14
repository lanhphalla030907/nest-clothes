import { Injectable } from '@nestjs/common';
import { Prisma, type Inventory } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { StockAlertFilter } from '../../inventory/dto/stock-alerts-response.dto.js';

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

/** Parameters for the paginated stock alert query. */
export interface StockAlertsPageParams {
  page: number;
  limit: number;
  search: string | undefined;
  status: StockAlertFilter;
}

/**
 * The relations a stock alert row needs: the owning variant, its product (for the
 * name and the primary image) and the variant's option pairs (for colour/size).
 *
 * A single query rather than three: the alert table is one row per variant and
 * every column it renders lives on this path. The image ordering matches the
 * storefront's "primary first, then sort order" rule so the thumbnail is the one
 * a customer would see.
 */
const STOCK_ALERT_INCLUDE = {
  variant: {
    include: {
      product: {
        include: {
          images: {
            orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
            take: 1,
          },
        },
      },
      options: { orderBy: [{ optionName: 'asc' }] },
    },
  },
} satisfies Prisma.InventoryInclude;

export type InventoryWithVariant = Prisma.InventoryGetPayload<{
  include: typeof STOCK_ALERT_INCLUDE;
}>;

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
   * Returns one page of the stock alert rows plus the summary counts and the
   * matching total.
   *
   * The page, the count and the summary are produced from one shared `where`
   * clause, so they can never describe different filters. Filtering happens in
   * the database before pagination: the `WHERE` clause (search plus the derived
   * stock status) is evaluated first, then the result is ordered and sliced with
   * `LIMIT`/`OFFSET`. Only variants that have an inventory row are returned.
   *
   * `available = quantity - reserved_quantity` and the stock status are derived
   * in SQL, so the same thresholds the service applies elsewhere (`available >
   * 10` in stock, `1..10` low, `<= 0` out of stock) drive both the filter and
   * the summary. The summary covers every record matching the search filter,
   * not only the current page.
   *
   * The ids are fetched in their final database order and hydrated through a
   * single typed Prisma query, so the variant/product/image/option relations
   * are loaded without N+1 queries.
   */
  async findStockAlertsPage(
    params: StockAlertsPageParams,
  ): Promise<{
    items: InventoryWithVariant[];
    total: number;
    inStock: number;
    lowStock: number;
    outOfStock: number;
  }> {
    const { page, limit, search, status } = params;
    const skip = (page - 1) * limit;

    const itemsWhere = this.stockAlertsWhere(search, status);
    const idRows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT i.id
      FROM "inventory" i
      JOIN "product_variants" v ON v.id = i."variant_id"
      JOIN "products" p ON p.id = v."product_id"
      WHERE ${itemsWhere}
      ORDER BY
        CASE
          WHEN i.quantity - i.reserved_quantity <= 0 THEN 0
          WHEN i.quantity - i.reserved_quantity <= 10 THEN 1
          ELSE 2
        END,
        (i.quantity - i.reserved_quantity),
        p.name,
        v.sku
      LIMIT ${limit} OFFSET ${skip}
    `;

    const summaryWhere = this.stockAlertsWhere(search, 'all');
    const [summaryRow] = await this.prisma.$queryRaw<{
      total: string;
      in_stock: string;
      low_stock: string;
      out_of_stock: string;
    }[]>`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE i.quantity - i.reserved_quantity > 10) AS in_stock,
        COUNT(*) FILTER (WHERE i.quantity - i.reserved_quantity BETWEEN 1 AND 10) AS low_stock,
        COUNT(*) FILTER (WHERE i.quantity - i.reserved_quantity <= 0) AS out_of_stock
      FROM "inventory" i
      JOIN "product_variants" v ON v.id = i."variant_id"
      JOIN "products" p ON p.id = v."product_id"
      WHERE ${summaryWhere}
    `;

    const ids = idRows.map((row) => row.id);
    let items: InventoryWithVariant[] = [];
    if (ids.length > 0) {
      const hydrated = await this.prisma.inventory.findMany({
        where: { id: { in: ids } },
        include: STOCK_ALERT_INCLUDE,
      });
      const byId = new Map(hydrated.map((item) => [item.id, item]));
      items = ids
        .map((id) => byId.get(id))
        .filter((item): item is InventoryWithVariant => item !== undefined);
    }

    return {
      items,
      total: Number(summaryRow?.total ?? 0),
      inStock: Number(summaryRow?.in_stock ?? 0),
      lowStock: Number(summaryRow?.low_stock ?? 0),
      outOfStock: Number(summaryRow?.out_of_stock ?? 0),
    };
  }

  /**
   * Builds the `WHERE` fragment for the stock alert query.
   *
   * Search matches the product name or the variant SKU, case-insensitively.
   * The status filter constrains the derived available stock (`quantity -
   * reserved_quantity`); `all` applies no status constraint so the summary can
   * count every matching record regardless of the table's tab.
   */
  private stockAlertsWhere(
    search: string | undefined,
    status: StockAlertFilter,
  ): Prisma.Sql {
    const conditions: Prisma.Sql[] = [];

    if (search) {
      const term = `%${search}%`;
      conditions.push(Prisma.sql`(p.name ILIKE ${term} OR v.sku ILIKE ${term})`);
    }

    switch (status) {
      case 'in':
        conditions.push(Prisma.sql`i.quantity - i.reserved_quantity > 10`);
        break;
      case 'low':
        conditions.push(Prisma.sql`i.quantity - i.reserved_quantity BETWEEN 1 AND 10`);
        break;
      case 'out':
        conditions.push(Prisma.sql`i.quantity - i.reserved_quantity <= 0`);
        break;
      case 'alerts':
        conditions.push(Prisma.sql`i.quantity - i.reserved_quantity <= 10`);
        break;
    }

    if (conditions.length === 0) return Prisma.sql`TRUE`;
    return Prisma.join(conditions, ' AND ');
  }

  async lockByVariantIds(
    variantIds: string[],
    client: InventoryTransactionClient,
  ): Promise<void> {
    if (variantIds.length === 0) return;

    const orderedIds = [...variantIds].sort();
    await client.$queryRaw<{ variant_id: string }[]>`
      SELECT "variant_id"
      FROM "inventory"
      WHERE "variant_id" = ANY(${orderedIds}::uuid[])
      ORDER BY "variant_id"
      FOR UPDATE
    `;
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
