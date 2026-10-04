/**
 * The payment lifecycle, as stored in `payments.status`.
 *
 * ## An attempt, not a payment method
 *
 * A row here is one *attempt* to collect money for an order, and `Order` has many of
 * them. That is why `FAILED` and `EXPIRED` exist as first-class states rather than as
 * deletions: a customer's bank declining their card is a fact about the attempt, and
 * losing it would make a later successful attempt look like the first one.
 *
 * ```
 *            ┌──────────► EXPIRED   (the QR timed out unpaid)
 *            │              │
 *            │              ▼
 *            │          PAID       (a late callback proves the money did arrive)
 *            │              ▲
 * PENDING ───┼──────────► FAILED ────┘   (declined, or the provider call failed)
 *    ▲       │
 *    │       └──────────► PAID          (verified against the provider)
 *    │
 *    └── a new attempt for the same order, once the previous one left PENDING
 * ```
 *
 * `PAID` is the only state the order cares about, and it is reachable from every other
 * one. That is deliberate and it is not a hole in the guard: `FAILED` and `EXPIRED`
 * record what *this application knew at the time*, and PayWay's answer is the authority
 * on whether money actually moved. A customer whose bank took the payment after our QR
 * had already timed out must still be recorded as having paid — writing that off as
 * unpaid because of our own clock would be a way to lose a customer's money. See
 * `PaymentRepository.markPaid`, whose guard is therefore "not already `PAID`" rather
 * than "is `PENDING`".
 *
 * `FAILED` and `EXPIRED` are otherwise terminal, in the sense that nothing else writes
 * them: there is no retry of a row, only a *new* attempt for the order.
 *
 * ## Why `PAID` may only be reached through verification
 *
 * Nothing in this phase sets `PAID` on the strength of an inbound request. The only
 * writer is the callback handler, and only after PayWay itself has confirmed the
 * transaction *and* the amount, currency and transaction id all match what we stored.
 * A `payments.status = 'PAID'` row is therefore a statement the application has
 * checked, not one it was told.
 *
 * ## No `REFUNDED` yet
 *
 * PayWay reports a refunded transaction, and mapping it onto a future state is
 * expected. It is absent here because refunds are explicitly out of scope for this
 * phase: a refund is a second movement of money and needs its own records, not a
 * status this phase could set without them. Until it exists, a refunded transaction
 * verifies as *not* collected, which is the safe direction to be wrong in.
 *
 * As with `orders.status`, the column is free-form rather than a Prisma enum so that
 * adding a state is not a migration; the vocabulary lives here so no service repeats
 * the literals.
 */
export const PAYMENT_STATUS = {
  /** Created, QR issued, awaiting the customer. The only status a new payment has. */
  PENDING: 'PENDING',
  /** Verified as collected by the provider. Final: nothing writes over it. */
  PAID: 'PAID',
  /**
   * Refused, or the attempt could not be started.
   *
   * Left for by a new attempt on the same order — and, rarely, corrected to `PAID` by a
   * late callback that proves the money did arrive.
   */
  FAILED: 'FAILED',
  /**
   * The QR timed out before the customer paid.
   *
   * Left for by a new attempt on the same order — and, rarely, corrected to `PAID` by a
   * late callback. Expiry is our clock, not the bank's.
   */
  EXPIRED: 'EXPIRED',
} as const;

export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

/**
 * Statuses an order can be asked to pay for.
 *
 * A `PENDING` order is the only payable state, which is the same rule the order
 * lifecycle already encodes: an order is written `PENDING` by checkout and nothing
 * else in the application promotes it. Payment is the first thing that does, and it
 * moves the order to `CONFIRMED` — the state the lifecycle has always reserved for
 * "the merchant has accepted the order and stock is committed".
 */
export const PAYABLE_ORDER_STATUS = 'PENDING';
