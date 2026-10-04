/**
 * The order lifecycle, as stored in `orders.status`.
 *
 * `orders.status` is a free-form column rather than a Prisma enum, mirroring
 * `users.status` and `products.status`: the values are an application-level
 * concept, they are never queried relationally, and adding one must not require a
 * migration. The values are centralised here so no service repeats the literals.
 *
 * The lifecycle is a single forward path with one exit:
 *
 * ```
 * PENDING -> CONFIRMED -> PROCESSING -> SHIPPED -> DELIVERED
 *    |           |            |           |
 *    +-----------+------------+-----------+--> CANCELLED
 * ```
 *
 * `CANCELLED` is reachable from any state before the parcel has left, and is
 * terminal — a cancelled order never resumes. `DELIVERED` is likewise terminal.
 *
 * ## Nothing here is a promise about behaviour
 *
 * The status exists so the aggregate is complete; the *transitions* are not
 * implemented in this phase. There is no route that changes a status, no
 * cancellation endpoint and no fulfilment workflow. An order is written once as
 * `PENDING` by the checkout phase that does not exist yet, and this phase only
 * ever reads it.
 */
export const ORDER_STATUS = {
  /** Recorded, not yet accepted by the merchant. The only status a new order has. */
  PENDING: 'PENDING',
  /** The merchant has accepted the order and stock is committed. */
  CONFIRMED: 'CONFIRMED',
  /** Being picked and packed in the warehouse. */
  PROCESSING: 'PROCESSING',
  /** Handed to the carrier. */
  SHIPPED: 'SHIPPED',
  /** Received by the customer. Terminal. */
  DELIVERED: 'DELIVERED',
  /** Abandoned before dispatch. Terminal. */
  CANCELLED: 'CANCELLED',
} as const;

export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

/**
 * Lifecycle an order starts in when it is written.
 *
 * An order is never implicitly confirmed: promotion past `PENDING` is an
 * explicit, authorised action (payment capture, merchant acceptance) that does
 * not exist yet.
 */
export const DEFAULT_ORDER_STATUS: OrderStatus = ORDER_STATUS.PENDING;

/**
 * Currency an order is denominated in when nothing else is specified.
 *
 * `orders.currency` is `CHAR(3)` holding an ISO 4217 alphabetic code. The default
 * lives here because it is a business decision rather than a schema detail, and
 * `currency` is stored per order rather than globally so a future multi-currency
 * storefront can write a different value per row without a migration.
 */
export const DEFAULT_ORDER_CURRENCY = 'USD';