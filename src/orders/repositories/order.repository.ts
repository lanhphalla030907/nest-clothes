import { Injectable } from '@nestjs/common';
import type { Order, OrderItem, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ORDER_STATUS } from '../constants/order-status.constants.js';

export type { Order, OrderItem };

/**
 * A Prisma client bound to an interactive transaction.
 *
 * Repository methods accept one so the service can run a read followed by a write
 * against the *same* connection and transaction. That is what lets a checkout read
 * a variant's price, resolve its options and insert the order line all from one
 * consistent view — a repricing that lands mid-checkout cannot produce an order
 * whose total disagrees with its own lines.
 */
export type OrderTransactionClient = Prisma.TransactionClient;

/**
 * An order plus its lines, oldest line first.
 *
 * Derived from the query below rather than hand-written, so the read shape and the
 * type describing it cannot drift apart.
 */
export type OrderWithItems = Prisma.OrderGetPayload<{
  include: typeof ORDER_ITEMS_INCLUDE;
}>;

/**
 * The exact columns {@link OrderRepository.createOrder} is allowed to write.
 *
 * `id`, `createdAt` and `updatedAt` are absent because they are database-owned and
 * must never be reachable from a request payload.
 *
 * `status` and `currency` are present but defaulted by the **service**, never by a
 * caller — see the note on `createOrder`.
 */
export interface CreateOrderData {
  userId: string;
  orderNumber: string;
  status: string;
  subtotal: string;
  shippingFee: string;
  discountAmount: string;
  totalAmount: string;
  currency: string;
  shippingRecipientName: string;
  shippingPhone: string;
  shippingAddressLine1: string;
  shippingAddressLine2: string | null;
  shippingCity: string;
  shippingStateProvince: string | null;
  shippingPostalCode: string | null;
  shippingCountryCode: string;
  /** Nested lines, written in the same statement as the order itself. */
  items: { create: CreateOrderItemData[] };
}

/**
 * The exact columns an order line may be written with.
 *
 * Every field is a **snapshot** taken from the catalogue at checkout. The absence
 * of any reference to a live price or product name is the point: `variantId` is the
 * only foreign key, and it exists so "which variant was this" stays answerable —
 * not so the row can be rendered from it.
 */
export interface CreateOrderItemData {
  variantId: string;
  productName: string;
  sku: string;
  variantOptionsSnapshot: { optionName: string; optionValue: string }[];
  unitPrice: string;
  quantity: number;
  lineTotal: string;
}

/**
 * The relation projection every order read shares.
 *
 * `variant` is **deliberately absent**. An order item renders entirely from its own
 * snapshot columns — `productName`, `sku`, `variantOptionsSnapshot`, `unitPrice` —
 * and joining the live variant would be precisely the bug this table exists to
 * prevent: renaming a product would silently rewrite what a past receipt says. The
 * `variantId` is returned so a client *can* link onward, but nothing is read
 * through it.
 *
 * Items are ordered oldest-first with `id` as the tiebreak so two identical
 * requests return the lines in the same order; Postgres does not guarantee the
 * insertion order of rows written in one transaction without an explicit sort.
 */
const ORDER_ITEMS_INCLUDE = {
  items: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.OrderInclude;

/**
 * Ordering for a user's order history: newest first.
 *
 * `createdAt desc` is what "newest first" means to a user, and `id desc` breaks ties
 * so two orders placed in the same millisecond still come back in a stable,
 * repeatable order. The columns are declared in the same order and direction as
 * `orders_user_id_created_at_id_idx`, so Postgres satisfies this ordering from the
 * index rather than sorting the user's history.
 */
const ORDER_HISTORY_ORDER_BY = [
  { createdAt: 'desc' },
  { id: 'desc' },
] satisfies Prisma.OrderOrderByWithRelationInput[];

/**
 * Ordering when snapshotting a variant's options onto an order line.
 *
 * Mirrors the ordering `variant_options` reads use elsewhere, so the snapshot of
 * `Color = Black, Size = M` is stored in the same order every time and two orders
 * of the same variant produce byte-identical JSON.
 */
const VARIANT_OPTION_SNAPSHOT_ORDER_BY = [
  { optionName: 'asc' },
  { id: 'asc' },
] satisfies Prisma.VariantOptionOrderByWithRelationInput[];

/**
 * The only place in the orders feature that talks to the database.
 *
 * It owns `orders` and `order_items` together because the two are one aggregate: a
 * line has no meaning without its order and is unreachable without it, so splitting
 * them across repositories would buy an abstraction that cannot be used.
 *
 * `users`, `product_variants`, `products` and `variant_options` are **not** owned
 * here. `users` is reached through `UsersRepository`. The catalogue tables are only
 * ever *read*, and only by the two `…ForCheckout` methods, which exist so this
 * repository does not have to import the sibling repositories to take a snapshot.
 * No order read touches them at all.
 *
 * It owns persistence and nothing else: no money arithmetic, no order-number
 * generation, no sellability or ownership decisions, no exception mapping, no DTO
 * mapping, no HTTP status decisions. Each of those belongs to `OrderService`.
 *
 * ## The write is a nested create, on purpose
 *
 * {@link createOrder} inserts the order and its lines in **one** statement via
 * `items.create`. That is not a convenience: an order written without its lines
 * would be a financial record with no contents, and a two-step insert would leave a
 * window in which a concurrent reader could observe exactly that. A single
 * statement makes the intermediate state unobservable even at `READ COMMITTED`.
 *
 * ## The database constraints remain the final backstop
 *
 * The service validates quantities, money and sellability before writing, so a bad
 * request gets a deterministic 400. It cannot be the guarantee: another writer may
 * interleave, and the service's own arithmetic could contain a bug. The
 * `CHECK` constraints in the migration — `quantity > 0`, `unit_price > 0`,
 * `line_total > 0`, `line_total = unit_price * quantity`,
 * `total_amount = subtotal + shipping_fee - discount_amount`, and non-negative
 * money — are what make an invalid order impossible to persist regardless.
 */
@Injectable()
export class OrderRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `work` in a single interactive transaction and hands it a client bound to
   * that transaction. Used for every order write, so a read of the catalogue and
   * the insert of the resulting line share one consistent view.
   */
  runInTransaction<T>(
    work: (tx: OrderTransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(work);
  }

  /**
   * Returns the order with `id` together with its items, or `null` when no such
   * order exists.
   *
   * Note what this does **not** do: it does not filter by owner. The service decides
   * ownership, because an order belonging to somebody else is a 404 rather than a
   * 403 and the response must not distinguish "absent" from "not yours". Scoping in
   * the query would hide the difference from the service, which needs to apply the
   * same rule for both.
   *
   * This is the shape `GET /orders/:id` needs, items included, so one query answers
   * the whole request.
   */
  findById(
    id: string,
    client: OrderTransactionClient = this.prisma,
  ): Promise<OrderWithItems | null> {
    return client.order.findUnique({
      where: { id },
      include: ORDER_ITEMS_INCLUDE,
    });
  }

  /**
   * Returns one user's orders, newest first, each with its items.
   *
   * Scoped by `userId` in the query rather than fetched and filtered in the
   * service: the database then only ever returns rows the caller is entitled to, so
   * there is no window in which another user's order is in memory.
   *
   * Items are included because the listing is an order *summary* derived from the
   * lines (an item count and a line count), and one query is both cheaper and more
   * consistent than a listing followed by per-order fetches that could interleave
   * with a concurrent write.
   */
  findByUserId(
    userId: string,
    client: OrderTransactionClient = this.prisma,
  ): Promise<OrderWithItems[]> {
    return client.order.findMany({
      where: { userId },
      include: ORDER_ITEMS_INCLUDE,
      orderBy: ORDER_HISTORY_ORDER_BY,
    });
  }

  /**
   * Returns the order carrying `orderNumber`, or `null`.
   *
   * Backs the generator's collision pre-check. It returns the full projection
   * rather than a `count` for one reason: it keeps a single query shape for every
   * order lookup, and the pre-check only ever tests for `null`.
   */
  findByOrderNumber(
    orderNumber: string,
    client: OrderTransactionClient = this.prisma,
  ): Promise<OrderWithItems | null> {
    return client.order.findUnique({
      where: { orderNumber },
      include: ORDER_ITEMS_INCLUDE,
    });
  }

  /**
   * Whether `orderNumber` is already taken, without transferring any rows.
   *
   * **This is not a uniqueness guarantee and must never be treated as one.** Two
   * concurrent callers can both be told `false` here before either has inserted.
   * Only the `UNIQUE` constraint on `orders.order_number` settles that race, which
   * is why the checkout retries on the constraint instead of trusting this method.
   * It exists to avoid collisions that are *visible* — re-drawing a number a moment
   * ago — not to prevent them.
   */
  async existsOrderNumber(
    orderNumber: string,
    client: OrderTransactionClient = this.prisma,
  ): Promise<boolean> {
    const found = await client.order.findUnique({
      where: { orderNumber },
      select: { id: true },
    });

    return found !== null;
  }

  /**
   * Inserts an order and its lines in one statement, and returns it hydrated.
   *
   * **No public route reaches this method.** It exists so the money, snapshot and
   * order-number rules have somewhere real to live and something real to be tested
   * against; the checkout that will call it over HTTP does not exist yet. Prices,
   * totals, status and snapshots are therefore writable only from inside the
   * service, never from a request body.
   *
   * Rejects with Prisma's `P2002` when `order_number` collides, which is exactly
   * the concurrent-placement race: the caller regenerates and retries. A `CHECK`
   * violation surfaces as `P2039` and is a genuine bug in the arithmetic
   * upstream — it is deliberately not translated into a retry.
   */
  createOrder(
    data: CreateOrderData,
    client: OrderTransactionClient = this.prisma,
  ): Promise<OrderWithItems> {
    return client.order.create({
      data,
      include: ORDER_ITEMS_INCLUDE,
    });
  }

  /**
   * Reads a variant's identity and price for a checkout snapshot.
   *
   * Deliberately narrow: `id`, `productId`, `sku`, `price` and `isActive` are the
   * only columns a line needs in order to be written. Not selecting the whole row
   * is what keeps a future catalogue column — a cost price, an internal flag —
   * from ever reaching an order line by accident.
   *
   * Takes the transaction client so the price is read from the same view as the
   * insert that uses it.
   */
  findVariantForCheckout(
    variantId: string,
    client: OrderTransactionClient,
  ): Promise<{
    id: string;
    productId: string;
    sku: string;
    price: Prisma.Decimal;
    isActive: boolean;
  } | null> {
    return client.productVariant.findUnique({
      where: { id: variantId },
      select: {
        id: true,
        productId: true,
        sku: true,
        price: true,
        isActive: true,
      },
    });
  }

  /**
   * Reads a product's name for the `productName` snapshot on an order line, and
   * whether it is still on sale.
   *
   * As with {@link findVariantForCheckout}, the projection is the minimum: `name`
   * and `isActive`, and nothing else. The name is what the order must record the
   * product was *called* at purchase time; `isActive` is the sellability check,
   * which belongs on the product as well as the variant — a deactivated product
   * whose variants were left switched on must not be orderable, and deciding that
   * here keeps the rule next to the read that answers it rather than in a caller
   * that could forget it.
   */
  findProductForCheckout(
    productId: string,
    client: OrderTransactionClient,
  ): Promise<{ name: string; isActive: boolean } | null> {
    return client.product.findUnique({
      where: { id: productId },
      select: { name: true, isActive: true },
    });
  }

  /**
   * Promotes an order from `PENDING` to `CONFIRMED`, and reports whether it did.
   *
   * ## Why a guarded update rather than a read-then-write
   *
   * This is the first transition that moves an order past `PENDING`, and the guard
   * lives in the `WHERE` clause rather than in a preceding read. That distinction is
   * the whole point: `if (order.status === 'PENDING') await update(...)` compares
   * against a snapshot another request could invalidate before the write lands. Two
   * concurrent payment callbacks would both read `PENDING`, both write, and both
   * believe they had promoted the order.
   *
   * With `status: 'PENDING'` in the `WHERE`, the second statement matches zero rows
   * instead and reports `false`. Idempotency then costs nothing extra: a callback
   * arriving after the order is already `CONFIRMED` is not an error to handle, it is
   * the expected outcome of a retry.
   *
   * ## Why only `PENDING` is a legal source state
   *
   * Every later state means the order moved on without money — `CANCELLED` is
   * terminal in particular. Confirming one of those would sell something that was
   * withdrawn, and resurrecting a cancelled order is worse than failing, so the guard
   * is what refuses. No caller has to remember the rule.
   *
   * The result is a boolean rather than the updated order because callers do not need
   * the row; they need to know whether *they* performed the transition, and `false`
   * means an earlier attempt already did.
   *
   * Takes the transaction client so this promotion and the payment's own `PAID` write
   * commit together. An order confirmed with no recorded payment, or a payment against
   * an order still `PENDING`, are both states this application must never reach.
   */
  async confirmPaid(
    id: string,
    client: OrderTransactionClient = this.prisma,
  ): Promise<boolean> {
    const updated = await client.order.updateMany({
      where: { id, status: ORDER_STATUS.PENDING },
      data: { status: ORDER_STATUS.CONFIRMED },
    });

    return updated.count === 1;
  }

  /**
   * Reads a variant's options so they can be **snapshotted** onto an order line.
   *
   * This is the only place the orders feature reads catalogue data, and it happens
   * only at write time. Once the JSONB column is written it is the truth: editing
   * or deleting a `variant_options` row must not change what a placed order says,
   * which is why no order *read* joins this table.
   *
   * Ordered deterministically so the snapshot of `Color = Black, Size = M` is
   * stored in the same order every time — two orders of the same variant produce
   * byte-identical JSON, which keeps equality assertions in tests meaningful.
   */
  findVariantOptionsForSnapshot(
    variantId: string,
    client: OrderTransactionClient,
  ): Promise<{ optionName: string; optionValue: string }[]> {
    return client.variantOption.findMany({
      where: { variantId },
      orderBy: VARIANT_OPTION_SNAPSHOT_ORDER_BY,
      select: { optionName: true, optionValue: true },
    });
  }
}