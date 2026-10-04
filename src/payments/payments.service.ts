import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { ORDER_STATUS } from '../orders/constants/order-status.constants.js';
import type { OrderWithItems } from '../orders/repositories/order.repository.js';
import { OrderRepository } from '../orders/repositories/order.repository.js';
import {
  PAYABLE_ORDER_STATUS,
  PAYMENT_STATUS,
} from './constants/payment-status.constants.js';
import { PaywayCallbackAckDto } from './dto/payway-callback-ack.dto.js';
import type { PaywayCallbackDto } from './dto/create-payment.dto.js';
import { PaymentResponseDto } from './dto/payment-response.dto.js';
import { TransactionIdGenerator } from './payment-transaction-id.generator.js';
import {
  PaymentRepository,
  type Payment,
  type PaymentQrPayload,
} from './repositories/payment.repository.js';
import { PAYWAY_PROVIDER_NAME } from './payway/payway.constants.js';
import {
  formatPaywayAmount,
  isValidPaywayTransactionId,
} from './payway/payway-hash.js';
import { PaywayService } from './payway/payway.service.js';

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

/**
 * How many times a *fresh* transaction id is tried when the unique index rejects the
 * previous one.
 *
 * This is a collision between two 18-character ids sharing a twelve-digit timestamp —
 * an event with probability around 2.18e-9 for any given pair in the same second. One
 * retry is generous; the loop is bounded anyway so the function is total.
 */
const MAX_TRANSACTION_ID_ATTEMPTS = 3;

/**
 * How long a duplicate request waits for the in-flight original to attach its QR,
 * in milliseconds, and how often it looks.
 *
 * ## Why waiting at all
 *
 * The row is inserted before PayWay is called, so for a few hundred milliseconds an
 * order's live payment exists with **no QR on it**. A duplicate request that arrived in
 * that window and returned immediately would have to answer with a payment the client
 * cannot scan — technically "the existing payment", and useless.
 *
 * The alternative designs were both worse. Returning 409 unconditionally would reject
 * the common case where the duplicate lands a second later and a perfectly good QR is
 * already stored. And holding a database transaction open across the provider call to
 * make the row appear atomically would pin a connection for up to the 10-second PayWay
 * timeout and, worse, roll the `PENDING` row back on a provider failure — losing the
 * record of an attempt the customer may already be looking at.
 *
 * So the duplicate polls, briefly. The window it is covering is one HTTP round trip to
 * PayWay; the bound is deliberately shorter than the provider timeout, and when it
 * expires the honest answer is the 409 below — "a payment is already being prepared" —
 * which is true, and which the client resolves by retrying.
 */
const QR_ATTACH_POLL_TIMEOUT_MS = 1_500;
const QR_ATTACH_POLL_INTERVAL_MS = 50;

/** Sleep, used only by the bounded poll above. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Everything that turns an order into a paid order.
 *
 * ## The one rule worth stating plainly
 *
 * **Nothing a client sends can make a payment succeed.** The request body is empty, the
 * amount and currency are read from the order row, and the only transition to `PAID` is
 * made after PayWay has independently confirmed the transaction *and* the amount,
 * currency and transaction id all match what this application stored. A caller who
 * forges the webhook, replays it, or sends `{"status":"PAID"}` moves nothing.
 *
 * ## What lives here versus in `PaywayService`
 *
 * `PaywayService` speaks HTTP and validates PayWay's replies; it makes no decisions.
 * This class makes every decision, because it is the only place that can see PayWay's
 * claim *and* our own record at the same time — and comparing those two is the security
 * property. Nothing else in the application is allowed to write `PAID`.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly payments: PaymentRepository,
    private readonly orders: OrderRepository,
    private readonly transactionIds: TransactionIdGenerator,
    private readonly payway: PaywayService,
  ) {}

  /**
   * Returns a payable QR for `orderId`, creating the payment attempt if there is not
   * already a live one.
   *
   * The flow, and the reason for each step:
   *
   * 1. **Read the order, and check ownership.** Not scoped in the query — see
   *    {@link OrderRepository.findById}. Somebody else's order is a 404, identical to
   *    an absent one, so this endpoint cannot be used to probe for order ids.
   * 2. **Refuse a non-`PENDING` order** with 409. This is what stops a second payment
   *    for an order that is already `CONFIRMED`, and it is the check that makes the
   *    partial unique index a backstop rather than the primary defence.
   * 3. **Return any live attempt** instead of minting a second PayWay transaction. This
   *    is the idempotency the endpoint promises: a customer who taps "pay" twice, or
   *    whose client retries, gets the QR they already had.
   * 4. **Insert the `PENDING` attempt**, before contacting PayWay. Doing it in this
   *    order is deliberate: the row is what makes a concurrent duplicate collapse onto
   *    this same attempt, and it is the durable record that survives a provider failure.
   * 5. **Ask PayWay for a QR**, outside any database transaction, and store what comes
   *    back.
   * 6. **Mark the attempt `FAILED`** if the provider call did not produce a QR, so the
   *    next request starts a clean attempt instead of returning a dead one forever.
   *
   * @throws NotFoundException 404 when the order does not exist or is not the caller's.
   * @throws ConflictException 409 when the order is not `PENDING`, or when a live
   *   attempt exists whose QR has not arrived yet.
   * @throws UnprocessableEntityException 422 when the order's currency or total cannot
   *   be charged through PayWay at all.
   */
  async createPayment(
    userId: string,
    orderId: string,
  ): Promise<PaymentResponseDto> {
    const order = await this.loadPayableOrder(userId, orderId);

    const existing = await this.payments.findPendingByOrderId(order.id);
    if (existing !== null) {
      return this.respondWithLiveQr(existing.id);
    }

    // Derived here, once, from the order row. Both values are then used *twice* — once
    // formatted for the wire and once for the hash — from the same string, so the
    // signed amount and the sent amount cannot drift apart.
    const amount = this.payableAmount(order);
    const currency = order.currency.toUpperCase();

    const payment = await this.createPendingAttempt(order, amount, currency);

    // Lost the race for the order: the winner owns the provider call, so this request
    // answers with whatever the winner stored rather than creating a second QR.
    if (!payment.isOwner) {
      return this.respondWithLiveQr(payment.payment.id);
    }

    const qrPayload = await this.requestQr(payment.payment, amount, currency);

    const stored = await this.payments.attachQrPayload(payment.payment.id, qrPayload);

    // A `false` here means the row stopped being `PENDING` between the insert and now
    // — the only writer that could do it is the callback handler, which would mean the
    // customer paid faster than the QR could be stored. The payment is already right;
    // this response just has to report it truthfully rather than claim a QR is pending.
    return stored
      ? PaymentResponseDto.fromEntity(payment.payment, qrPayload)
      : this.respondWithLiveQr(payment.payment.id, { stopPolling: true });
  }

  /**
   * Handles PayWay's webhook.
   *
   * ## Why the payload is only ever a lookup key
   *
   * The callback arrives unauthenticated: whatever host can reach the endpoint can post
   * to it, and PayWay's own documentation describes no signature over it. So
   * `merchant_ref` is used for exactly one thing — finding the row — and then the
   * application asks PayWay, server to server, what actually happened. A forged
   * `{"merchant_ref": "…", "payment_status": "APPROVED"}` reaches step three and stops,
   * because PayWay will report the transaction as unpaid.
   *
   * ## Idempotency, in two independent places
   *
   * A payment already `PAID` short-circuits before any provider call, so a duplicate
   * delivery costs nothing. Two deliveries that *race* both reach the write, and the
   * guarded `updateMany` in {@link PaymentRepository.markPaid} lets exactly one of them
   * through; the other finds nothing to update and reports success. PayWay's retry
   * behaviour therefore cannot produce a double-confirmed order or a 500.
   *
   * @throws BadRequestException 400 when the payload carries no usable transaction id.
   * @throws NotFoundException 404 when no payment carries that transaction id.
   * @throws ConflictException 409 when PayWay confirms a payment whose amount, currency
   *   or transaction id disagrees with what we stored. The order stays `PENDING`.
   */
  async handlePaywayCallback(
    payload: PaywayCallbackDto,
  ): Promise<PaywayCallbackAckDto> {
    const transactionId = payload.merchantRef ?? payload.transactionId;

    if (
      transactionId === undefined ||
      !isValidPaywayTransactionId(transactionId)
    ) {
      throw new BadRequestException(
        'The callback did not identify a payment transaction',
      );
    }

    const payment = await this.payments.findByTransactionId(transactionId);

    if (payment === null) {
      // Not a 200. PayWay retries, and if a payment really does carry this id the row
      // will exist on the retry — which is the only outcome worth waiting for.
      throw new NotFoundException('No payment matches this transaction');
    }

    if (payment.status === 'PAID') {
      return PaywayCallbackAckDto.alreadyRecorded();
    }

    const order = await this.orders.findById(payment.orderId);
    if (order === null) {
      // The FK is `RESTRICT`, so this is unreachable while the schema is intact. It is
      // still handled rather than dereferenced: an order-less payment has no total to
      // verify against, and confirming one would be confirming nothing.
      this.logger.error(
        `Payment ${payment.id} has no order; refusing to confirm it`,
      );

      throw new ConflictException('The payment could not be verified');
    }

    const check = await this.payway.checkTransaction({ transactionId });

    if (!this.payway.isCollected(check)) {
      // Not an error. PayWay sends a callback the moment a transaction changes, which
      // includes "the customer is still typing their PIN". The attempt stays `PENDING`
      // so the customer can still complete it, and the order stays `PENDING` because
      // nothing has been collected.
      this.logger.log(
        `PayWay reports transaction ${transactionId} as ${check.paymentStatus}/${check.paymentStatusCode}; order left PENDING`,
      );

      return PaywayCallbackAckDto.notCollected();
    }

    // Collected. Three checks must all agree before a single row is written, and each
    // one closes a way for money to be attributed to the wrong order.
    this.assertMatchesOrder(payment.transactionId, order, check);

    const wasRecorded = await this.payments.runInTransaction(async (tx) => {
      const marked = await this.payments.markPaid(
        payment.id,
        {
          providerReference: check.apv,
          paidAt: check.transactionDate
            ? new Date(check.transactionDate)
            : new Date(),
        },
        tx,
      );

      if (!marked) {
        // A concurrent delivery got there first. It also promoted the order, inside its
        // own transaction, so there is nothing left to do.
        return false;
      }

      const promoted = await this.orders.confirmPaid(order.id, tx);

      if (!promoted) {
        // Money is collected but the order is not `PENDING` — it was cancelled, or
        // something else advanced it, between the read above and this write. Unreachable
        // while cancellation does not exist, and deliberately loud rather than silent
        // if that ever changes: a collected payment with no confirmed order needs a
        // human, and pretending otherwise is how a shop loses track of its own money.
        this.logger.error(
          `Payment ${payment.id} was collected but order ${order.id} was ${order.status}, not ${ORDER_STATUS.PENDING}`,
        );
      }

      return true;
    });

    this.logger.log(
      wasRecorded
        ? `Payment ${payment.id} verified as collected; order ${order.id} confirmed`
        : `Payment ${payment.id} was already recorded by a concurrent callback`,
    );

    return PaywayCallbackAckDto.recorded();
  }

  /**
   * Confirms that what PayWay collected is what this order charged.
   *
   * Every mismatch is a 409 with the detail in the log and nothing in the body. The
   * endpoint is unauthenticated, so a body that said "expected 129.00 USD, PayWay says
   * 12.90 KHR" would hand a prober a way to enumerate orders; the operator reading the
   * log gets everything they need.
   *
   * @throws ConflictException 409 on any disagreement, leaving the order `PENDING`.
   */
  private assertMatchesOrder(
    transactionId: string,
    order: OrderWithItems,
    check: {
      totalAmount: Prisma.Decimal;
      paymentAmount: Prisma.Decimal;
      paymentCurrency: string;
    },
  ): void {
    const expectedAmount = order.totalAmount;
    const expectedCurrency = order.currency.toUpperCase();
    const settledCurrency = check.paymentCurrency.toUpperCase();

    // `equals`, not `toString`: `Decimal('129.00').equals(Decimal('129'))` is true,
    // which is the right answer — the provider's formatting is its own business, and
    // treating a trailing zero as a mismatch would reject honest payments.
    const problems: string[] = [];

    if (!check.totalAmount.equals(expectedAmount)) {
      problems.push(`total_amount ${check.totalAmount} != ${expectedAmount}`);
    }

    if (!check.paymentAmount.equals(expectedAmount)) {
      problems.push(`payment_amount ${check.paymentAmount} != ${expectedAmount}`);
    }

    if (settledCurrency !== expectedCurrency) {
      problems.push(`currency ${settledCurrency} != ${expectedCurrency}`);
    }

    if (problems.length > 0) {
      this.logger.error(
        `Transaction ${transactionId} does not match order ${order.id}: ${problems.join('; ')}`,
      );

      throw new ConflictException('The payment could not be verified');
    }
  }

  /**
   * Loads an order the caller owns and that is still payable.
   *
   * Both checks raise, and they raise different codes for a reason that matters to the
   * client: 404 means "that order is not yours, or does not exist" — the two are
   * deliberately indistinguishable — and 409 means "we both know it is yours, and it
   * cannot be paid".
   */
  private async loadPayableOrder(
    userId: string,
    orderId: string,
  ): Promise<OrderWithItems> {
    const order = await this.orders.findById(orderId);

    if (order === null || order.userId !== userId) {
      throw new NotFoundException('Order not found');
    }

    if (order.status !== PAYABLE_ORDER_STATUS) {
      throw new ConflictException(
        `Order ${order.orderNumber} is ${order.status} and cannot be paid`,
      );
    }

    return order;
  }

  /**
   * The amount to charge, rendered the way PayWay must receive it.
   *
   * @throws UnprocessableEntityException 422 when the total is not payable through
   *   PayWay — an unsupported currency, or a total below the provider's floor. Neither
   *   is the caller's fault and neither is the provider's, so it is neither a 400 nor a
   *   502: the order simply cannot be paid this way.
   */
  private payableAmount(order: OrderWithItems): string {
    try {
      return formatPaywayAmount(order.totalAmount, order.currency);
    } catch (error) {
      this.logger.error(
        `Order ${order.id} cannot be charged through PayWay: ${error instanceof Error ? error.message : 'unknown reason'}`,
      );

      throw new UnprocessableEntityException(
        'This order cannot be paid with the configured payment provider',
      );
    }
  }

  /**
   * Inserts the `PENDING` attempt, retrying only on a transaction-id collision.
   *
   * Both unique constraints surface as the same `P2002`, and they mean opposite things,
   * so they are told apart by **what the database looks like afterwards** rather than by
   * reading Prisma's `meta.target` — which driver adapters such as `@prisma/adapter-pg`
   * leave empty. If a live attempt for the order now exists, the *order* index fired
   * and this is a concurrent duplicate, so the winner is returned instead. If none
   * exists, the *transaction id* index fired, which can only be a generator collision,
   * and a new id is tried.
   */
  /**
   * Inserts the `PENDING` attempt, retrying only on a transaction-id collision.
   *
   * Both unique constraints surface as the same `P2002`, and they mean opposite things,
   * so they are told apart by **what the database looks like afterwards** rather than by
   * reading Prisma's `meta.target` — which driver adapters such as `@prisma/adapter-pg`
   * leave empty. If a live attempt for the order now exists, the *order* index fired
   * and this is a concurrent duplicate, so the winner is adopted rather than replaced.
   * If none exists, the *transaction id* index fired, which can only be a generator
   * collision, and a new id is tried.
   *
   * `isOwner` is what keeps the loser from asking PayWay for a second QR: only the
   * request that actually inserted the row is allowed to talk to the provider, and the
   * caller uses this flag to decide whether to return the existing QR or create one.
   */
  private async createPendingAttempt(
    order: OrderWithItems,
    amount: string,
    currency: string,
  ): Promise<{ payment: Payment; isOwner: boolean }> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ID_ATTEMPTS; attempt += 1) {
      const transactionId = this.transactionIds.build();

      try {
        const payment = await this.payments.createPending({
          orderId: order.id,
          provider: PAYWAY_PROVIDER_NAME,
          transactionId,
          status: PAYMENT_STATUS.PENDING,
          amount,
          currency,
        });

        return { payment, isOwner: true };
      } catch (error) {
        if (!this.isUniqueViolation(error)) {
          throw error;
        }

        // A live attempt now exists, so it was the *order* index: a concurrent request
        // won, and this one must collapse onto it rather than mint a second PayWay
        // transaction.
        const winner = await this.payments.findPendingByOrderId(order.id);
        if (winner !== null) {
          this.logger.log(
            `Concurrent payment creation for order ${order.id}; adopting attempt ${winner.id}`,
          );

          return { payment: winner, isOwner: false };
        }

        // Nothing for this order, so the *transaction id* index fired. That can only be
        // a generator collision: retry with a fresh id.
        this.logger.warn(
          `Transaction id ${transactionId} already exists; regenerating (attempt ${attempt} of ${MAX_TRANSACTION_ID_ATTEMPTS})`,
        );
      }
    }

    throw new ConflictException(
      'Could not allocate a payment reference; please retry',
    );
  }

  /**
   * Whether an error is Prisma's unique-constraint violation.
   *
   * Narrow on purpose. Every other `P2002` — or any other driver error — must not be
   * mistaken for "somebody else got there first", because the reaction to those two
   * situations is opposite: one retries with a new id, the other propagates as the bug
   * it is.
   */
  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION
    );
  }

  /**
   * Asks PayWay for a QR and records the attempt's fate either way.
   *
   * On failure the attempt is marked `FAILED` before the error propagates. That single
   * write is what keeps a dead attempt from blocking the order forever: the partial
   * unique index only constrains `PENDING` rows, so marking it failed is what lets the
   * customer's next tap start a fresh attempt. Without it, one transient PayWay outage
   * would leave every order in the shop permanently unpayable.
   *
   * Provider exceptions are deliberately not caught and re-wrapped. `PaywayService`
   * already reduced every failure mode to a 502 or a 503 carrying a message that is
   * safe to show, and re-wrapping would only risk widening it.
   */
  private async requestQr(
    payment: Payment,
    amount: string,
    currency: string,
  ): Promise<PaymentQrPayload> {
    let qr: Awaited<ReturnType<PaywayService['generateQr']>>;

    try {
      qr = await this.payway.generateQr({
        transactionId: payment.transactionId,
        amount,
        currency,
        // The callback URL is read from validated configuration inside `PaywayService`,
        // which also Base64-encodes it. Reading `process.env` here would introduce a
        // second, unvalidated source for a value that decides where PayWay posts the
        // outcome of a payment — and would silently disagree with the one that was
        // checked to be an absolute HTTPS URL at boot.
      });
    } catch (error) {
      await this.payments.markFailed(payment.id);
      throw error;
    }

    return {
      qrString: qr.qrString,
      ...(qr.qrImage === undefined ? {} : { qrImage: qr.qrImage }),
      ...(qr.abapayDeeplink === undefined
        ? {}
        : { abapayDeeplink: qr.abapayDeeplink }),
      lifetimeMinutes: qr.lifetimeMinutes,
      // Derived rather than parsed from PayWay: the QR is minted with a known lifetime,
      // and a client needs an instant to compare against a clock, not a duration it
      // could add to its own skewed one.
      expiresAt: new Date(
        Date.now() + qr.lifetimeMinutes * 60_000,
      ).toISOString(),
    };
  }

  /**
   * Returns a live attempt's QR, waiting briefly for an in-flight original to store
   * its own.
   *
   * @throws ConflictException 409 when the wait expires without a QR appearing.
   */
  private async respondWithLiveQr(
    paymentId: string,
    options: { stopPolling?: boolean } = {},
  ): Promise<PaymentResponseDto> {
    const deadline = Date.now() + QR_ATTACH_POLL_TIMEOUT_MS;
    let payment = await this.payments.findById(paymentId);

    while (
      payment !== null &&
      payment.qrPayload == null &&
      options.stopPolling !== true &&
      Date.now() < deadline
    ) {
      await delay(QR_ATTACH_POLL_INTERVAL_MS);
      payment = await this.payments.findById(paymentId);
    }

    if (payment === null) {
      throw new ConflictException(
        'This payment is no longer available; please start a new one',
      );
    }

    const payload = payment.qrPayload as PaymentQrPayload | null;

    if (payload === null) {
      // The original request is still talking to PayWay, or it died mid-flight. Either
      // way there is genuinely no QR yet, and saying so beats returning a payment the
      // customer cannot scan.
      throw new ConflictException(
        'A payment for this order is already being prepared; please retry in a moment',
      );
    }

    return PaymentResponseDto.fromEntity(payment, payload);
  }
}
