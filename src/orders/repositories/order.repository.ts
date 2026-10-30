import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import type {
  Order,
  OrderItem,
} from '../../generated/prisma/client.js';
import { PAYMENT_STATUS } from '../../payments/constants/payment-status.constants.js';
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
  paymentMethod?: string | null;
  shippingProviderId?: string | null;
  shippingProviderCode?: string | null;
  shippingProviderName?: string | null;
  codAreaId?: string | null;
  codAreaCode?: string | null;
  codAreaName?: string | null;
  shippingRecipientName: string;
  shippingPhone: string;
  shippingAddressLine1: string;
  shippingAddressLine2: string | null;
  shippingCity: string | null;
  shippingStateProvince: string | null;
  shippingLocationPcode?: string | null;
  shippingLocationSnapshot?: Prisma.InputJsonArray;
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
 * Global ordering for the administrative listing.
 *
 * The same deterministic `createdAt DESC, id DESC` used by a customer's history,
 * but without the `userId` equality prefix — which is why the schema now carries
 * `orders_created_at_id_idx` and `orders_status_created_at_id_idx`.
 */
const ADMIN_ORDER_ORDER_BY = [
  { createdAt: 'desc' },
  { id: 'desc' },
] satisfies Prisma.OrderOrderByWithRelationInput[];

/**
 * The safe payment projection for the listing.
 *
 * `qrPayload` is never selected. It is a provider artifact that belongs to the
 * payment attempt and may contain QR strings and deeplinks; an order list has no
 * use for it and an operator route has no reason to return it.
 */
const ADMIN_ORDER_PAYMENT_SUMMARY_SELECT = {
  id: true,
  status: true,
  provider: true,
  amount: true,
  currency: true,
  paidAt: true,
  createdAt: true,
} satisfies Prisma.PaymentSelect;

/** The safe payment projection for the detail view; still no `qrPayload`. */
const ADMIN_ORDER_PAYMENT_SELECT = {
  ...ADMIN_ORDER_PAYMENT_SUMMARY_SELECT,
  transactionId: true,
  paymentMethod: true,
  providerReference: true,
} satisfies Prisma.PaymentSelect;

/**
 * The listing projection.
 *
 * The customer relation is an explicit three-field selection: this is the only
 * administrative read that joins `users`, and it must never make `passwordHash`
 * (or any future credential column) reachable from an order response.
 *
 * Items are read only for their quantities, because the listing reports an item
 * count and a line count. Live product data is deliberately absent: an order line
 * is a snapshot, and joining the catalogue would misrepresent history.
 *
 * `payments` fetches exactly the latest attempt for the summary, while `_count`
 * with the same status predicate answers "has this order ever been paid?" without
 * a second query per row. Prisma emits the count as a subquery, so the page does
 * not become N+1.
 */
const ADMIN_ORDER_LIST_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  subtotal: true,
  shippingFee: true,
  discountAmount: true,
  totalAmount: true,
  currency: true,
  shippingRecipientName: true,
  shippingCity: true,
  shippingLocationSnapshot: true,
  shippingCountryCode: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  },
  items: {
    select: { quantity: true },
  },
  payments: {
    take: 1,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: ADMIN_ORDER_PAYMENT_SUMMARY_SELECT,
  },
  _count: {
    select: {
      payments: { where: { status: PAYMENT_STATUS.PAID } },
    },
  },
} satisfies Prisma.OrderSelect;

/**
 * The detail projection.
 *
 * Every immutable shipping and item snapshot column is included, plus every
 * payment attempt (newest first) in its safe projection. `variant` is still
 * absent: linking to a current product is not reading the ordered item from it.
 */
const ADMIN_ORDER_DETAIL_SELECT = {
  id: true,
  userId: true,
  orderNumber: true,
  status: true,
  subtotal: true,
  shippingFee: true,
  discountAmount: true,
  totalAmount: true,
  currency: true,
  shippingRecipientName: true,
  shippingPhone: true,
  shippingAddressLine1: true,
  shippingAddressLine2: true,
  shippingCity: true,
  shippingLocationSnapshot: true,
  shippingStateProvince: true,
  shippingPostalCode: true,
  shippingCountryCode: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  },
  items: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      orderId: true,
      variantId: true,
      productName: true,
      sku: true,
      variantOptionsSnapshot: true,
      unitPrice: true,
      quantity: true,
      lineTotal: true,
      createdAt: true,
    },
  },
  payments: {
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: ADMIN_ORDER_PAYMENT_SELECT,
  },
} satisfies Prisma.OrderSelect;

export type AdminOrderListRow = Prisma.OrderGetPayload<{
  select: typeof ADMIN_ORDER_LIST_SELECT;
}>;

export type AdminOrderDetailRow = Prisma.OrderGetPayload<{
  select: typeof ADMIN_ORDER_DETAIL_SELECT;
}>;

/** Filters the service has already validated and normalised. */
export interface AdminOrderListFilters {
  page: number;
  limit: number;
  status?: string;
  search?: string;
  createdFrom?: Date;
  createdTo?: Date;
}

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
 * The administrative projections additionally read two related tables through
 * explicit selections: the buyer (`users`) and the payment attempts
 * (`payments`). Those reads exist because an operator needs to identify the
 * customer and see whether money was collected, and they select only the safe
 * columns — never `passwordHash`, `qrPayload` or a provider callback body. Outside
 * those projections, `users` is reached through `UsersRepository`.
 *
 * `product_variants`, `products` and `variant_options` are **not** owned here. The
 * catalogue tables are only ever *read*, and only by the two `…ForCheckout`
 * methods, which exist so this repository does not have to import the sibling
 * repositories to take a snapshot. No order read touches them at all.
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
   * Returns only the status needed to decide an administrative transition.
   *
   * The read is not the concurrency guard: another transaction can change the
   * status immediately after this returns. {@link transitionStatus} is the guarded
   * write that decides whether *this* caller performed the transition. This read
   * exists to distinguish "no such order" (404) from "wrong current state" (409).
   */
  findStatusById(
    id: string,
    client: OrderTransactionClient = this.prisma,
  ): Promise<{ id: string; status: string } | null> {
    return client.order.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
  }

  /**
   * Returns the status of one order only when it belongs to `userId`.
   *
   * This is the owner-scoped counterpart to {@link findStatusById}. Scoping the
   * query rather than reading by id and comparing afterwards means another user's
   * order is never loaded into the service at all, and an absent order and one
   * owned by somebody else produce the same `null` for the same public 404.
   */
  findStatusByIdForUser(
    id: string,
    userId: string,
    client: OrderTransactionClient = this.prisma,
  ): Promise<{ id: string; status: string } | null> {
    return client.order.findFirst({
      where: { id, userId },
      select: { id: true, status: true },
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
   * Returns the persisted variant/quantity pairs of one order's lines.
   *
   * This is the **source of truth** for the inventory operations that release a
   * reservation or commit stock when an order is cancelled or shipped. The caller
   * supplies only an order id; the quantities come from `order_items`, never from a
   * request body or a client-supplied line. That is what stops a caller from
   * releasing a different amount than the order actually holds.
   *
   * The projection is deliberately the minimum — `variantId` and `quantity` — and
   * touches no catalogue table. Snapshot columns and live product relations are
   * irrelevant here; an order line's quantity is the only fact inventory needs.
   *
   * Duplicate lines for the same variant are returned as they were persisted. The
   * domain service groups them, because `order_items` intentionally has no
   * `(order_id, variant_id)` uniqueness: two lines of the same variant may have been
   * priced differently and must not be merged in the receipt.
   *
   * Takes a transaction client so the read and the guarded counter updates that use
   * it execute on the same view and commit or roll back together.
   */
  findItemQuantitiesByOrderId(
    orderId: string,
    client: OrderTransactionClient = this.prisma,
  ): Promise<{ variantId: string; quantity: number }[]> {
    return client.orderItem.findMany({
      where: { orderId },
      select: { variantId: true, quantity: true },
    });
  }

  /**
   * Returns one page of the global order listing and the matching total.
   *
   * The page and the count are issued in one transaction and share the `where`
   * built below, so the count can never describe filters the page did not use.
   * That is the property the pagination contract needs: `total` and `totalPages`
   * must describe the same result set the page was drawn from.
   *
   * The query is not scoped to a customer — only `OrderService.listOrdersForAdmin`
   * reaches this method, and its route is behind `RolesGuard`.
   */
  async findAdminPage(
    filters: AdminOrderListFilters,
  ): Promise<{ items: AdminOrderListRow[]; total: number }> {
    const where = buildAdminOrderWhere(filters);
    const skip = (filters.page - 1) * filters.limit;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        select: ADMIN_ORDER_LIST_SELECT,
        orderBy: ADMIN_ORDER_ORDER_BY,
        skip,
        take: filters.limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Returns any order, with its customer, snapshots and safe payment attempts.
   *
   * Unlike {@link findById}, this is not the customer-facing shape and is not
   * scoped by owner: administrative reads are legitimately cross-customer, and
   * the route that reaches this method requires `ADMIN`.
   *
   * A missing row returns `null`; the service turns that into a 404.
   */
  findAdminById(
    id: string,
    client: OrderTransactionClient = this.prisma,
  ): Promise<AdminOrderDetailRow | null> {
    return client.order.findUnique({
      where: { id },
      select: ADMIN_ORDER_DETAIL_SELECT,
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

  async lockCheckoutCatalog(
    variantIds: string[],
    client: OrderTransactionClient,
  ): Promise<void> {
    if (variantIds.length === 0) return;

    const ids = Prisma.join(variantIds.map((id) => Prisma.sql`${id}::uuid`));
    await client.$queryRaw`
      SELECT "id" FROM "product_variants"
      WHERE "id" IN (${ids})
      ORDER BY "id"
      FOR SHARE
    `;
    await client.$queryRaw`
      SELECT "id" FROM "products"
      WHERE "id" IN (
        SELECT "product_id" FROM "product_variants"
        WHERE "id" IN (${ids})
      )
      ORDER BY "id"
      FOR SHARE
    `;
    await client.$queryRaw`
      SELECT "id" FROM "variant_options"
      WHERE "variant_id" IN (${ids})
      ORDER BY "id"
      FOR SHARE
    `;
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
   * Whether an order has at least one payment the provider verified as collected.
   *
   * Used by the administrative rules, not by the payment flow: a `CONFIRMED` order
   * should have one, and an order being cancelled must not have one. It is a read,
   * so the caller must still use the guarded status transition as the authoritative
   * concurrency control; this only supplies the payment policy decision.
   */
  async hasPaidPayment(
    orderId: string,
    client: OrderTransactionClient = this.prisma,
  ): Promise<boolean> {
    const count = await client.payment.count({
      where: { orderId, status: PAYMENT_STATUS.PAID },
    });

    return count > 0;
  }

  /**
   * Moves an order from exactly `from` to `to`, reporting whether this call did it.
   *
   * The current status is in the `WHERE`, not in a preceding `if`. That is what
   * makes repeated or concurrent cancellation/shipment requests safe: two requests
   * can both read `PENDING`, but only the first `UPDATE` matches a row. The second
   * waits for the row lock, re-evaluates the predicate and affects zero rows, which
   * the service maps to a conflict before it touches inventory.
   *
   * The caller must use the same transaction client for this update and the
   * inventory movement, so a failed movement rolls the status change back.
   */
  async transitionStatus(
    id: string,
    from: string,
    to: string,
    client: OrderTransactionClient = this.prisma,
  ): Promise<boolean> {
    const updated = await client.order.updateMany({
      where: { id, status: from },
      data: { status: to },
    });

    return updated.count === 1;
  }

  /**
   * Owner-scoped counterpart to {@link transitionStatus}.
   *
   * The ownership predicate is part of the guarded `UPDATE`, not a check made
   * before it. A request for somebody else's order therefore affects zero rows
   * even if the service's earlier read and this write race with a change to the
   * row, and it can never release that order's inventory.
   */
  async transitionStatusForUser(
    id: string,
    userId: string,
    from: string,
    to: string,
    client: OrderTransactionClient = this.prisma,
  ): Promise<boolean> {
    const updated = await client.order.updateMany({
      where: { id, userId, status: from },
      data: { status: to },
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

/**
 * Escapes the characters PostgreSQL's `LIKE`/`ILIKE` treats as wildcards.
 *
 * Prisma's `contains` and `startsWith` build a `LIKE` pattern from the supplied
 * value and do not escape `%`, `_` or `\`. Without this, a search for `%` would
 * match every order and `_` would match any single character — an operator could
 * not search for a literal character, and the query would do far more work than
 * asked. PostgreSQL uses backslash as the default `LIKE` escape character, so
 * doubling a backslash and prefixing `%`/`_` makes each literal again.
 *
 * This is not string-concatenated SQL; the escaped value is still passed to
 * Prisma as a bound parameter.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/** Builds the shared `where` for the page and the total of the admin listing. */
function buildAdminOrderWhere(
  filters: AdminOrderListFilters,
): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = {};

  if (filters.status !== undefined) {
    where.status = filters.status;
  }

  if (filters.createdFrom !== undefined || filters.createdTo !== undefined) {
    where.createdAt = {
      ...(filters.createdFrom === undefined
        ? {}
        : { gte: filters.createdFrom }),
      ...(filters.createdTo === undefined ? {} : { lte: filters.createdTo }),
    };
  }

  if (filters.search !== undefined) {
    const pattern = escapeLikePattern(filters.search);

    where.OR = [
      { orderNumber: { startsWith: pattern, mode: 'insensitive' } },
      {
        user: {
          is: { firstName: { contains: pattern, mode: 'insensitive' } },
        },
      },
      {
        user: {
          is: { lastName: { contains: pattern, mode: 'insensitive' } },
        },
      },
      {
        user: {
          is: { email: { contains: pattern, mode: 'insensitive' } },
        },
      },
    ];
  }

  return where;
}
