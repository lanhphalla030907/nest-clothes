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
 * `CANCELLED` is terminal — a cancelled order never resumes. `DELIVERED` is
 * likewise terminal.
 *
 * ## Which transitions are actually exposed
 *
 * The lifecycle above documents the aggregate, not a menu of API actions. Three
 * transitions are implemented:
 *
 * - `PENDING -> CANCELLED` by the owning customer, releasing the reservation.
 * - `PENDING -> CANCELLED` by an administrator, releasing the reservation.
 * - `CONFIRMED -> SHIPPED` by an administrator, committing the reserved stock.
 *
 * Payment is still the only writer of `PENDING -> CONFIRMED`. A `CONFIRMED` order
 * has a verified `PAID` payment, and this application has no refund workflow, so
 * cancelling one would keep the customer's money without recording a refund. It is
 * therefore refused rather than silently treated as unpaid. `PROCESSING` has no
 * route and is refused for the same reason. There is deliberately no arbitrary
 * status-assignment endpoint.
 */
export const ORDER_STATUS = {
  /** Recorded, not yet accepted by the merchant. The only status a new order has. */
  PENDING: 'PENDING',
  /** The merchant has accepted the order and a verified payment exists. */
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
 * States from which an administrator may cancel an order.
 *
 * Only `PENDING`: it is the unpaid state checkout writes. A `CONFIRMED` order has
 * a verified payment, and refunds are not part of this application, so the service
 * refuses that cancellation instead of pretending the money was never captured.
 */
export const CANCELLABLE_ORDER_STATUSES: readonly OrderStatus[] = [
  ORDER_STATUS.PENDING,
];

/**
 * The one state from which an administrator may ship an order.
 *
 * `CONFIRMED` is written only by the verified payment callback, so the inventory
 * commitment is tied to an order the payment flow has already accepted.
 */
export const SHIPPABLE_ORDER_STATUS = ORDER_STATUS.CONFIRMED;

/**
 * Lifecycle an order starts in when it is written.
 *
 * An order is never implicitly confirmed: promotion past `PENDING` is an
 * explicit, authorised action — the verified payment callback for `CONFIRMED`,
 * and the administrator shipment action for `SHIPPED`.
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
