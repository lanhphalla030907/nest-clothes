import { Injectable } from '@nestjs/common';
import type { Payment, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PAYMENT_STATUS } from '../constants/payment-status.constants.js';

export type { Payment };

/**
 * A Prisma client bound to an interactive transaction, mirroring the orders feature so
 * the two repositories compose in the same call.
 */
export type PaymentTransactionClient = Prisma.TransactionClient;

/**
 * The QR data PayWay returned for a payment.
 *
 * Persisted as JSONB on `payments.qr_payload` so a replay of `POST
 * /orders/:orderId/payments` can hand back the *same* QR the customer was first shown,
 * without a second call to PayWay. That is the entire reason the column exists, and it
 * is the reason it is nullable rather than required: the row is inserted before
 * PayWay is asked, so for a window of a few hundred milliseconds it has no QR at all.
 *
 * Nothing sensitive is stored here — `qrString` is what the customer's own banking app
 * reads, and `qrImage` is a rendering of it. The API key that signed it never appears.
 *
 * A type alias rather than an interface, for one mechanical reason: Prisma's JSON input
 * type is an index-signature type, and TypeScript gives an implicit index signature to
 * an object *type literal* but not to a named `interface`. As an `interface` this would
 * need a cast to be written to the column at all — and a cast is exactly the hole a
 * future field could slip through untyped.
 */
export type PaymentQrPayload = {
  qrString: string;
  qrImage?: string;
  abapayDeeplink?: string;
  /** Lifetime the QR was minted with, so the client can count down without guessing. */
  lifetimeMinutes: number;
  /** ISO-8601 instant after which the QR is dead. Derived, and stored so it survives restarts. */
  expiresAt: string;
};

/** The exact columns a payment attempt may be created with. */
export interface CreatePaymentData {
  orderId: string;
  provider: string;
  transactionId: string;
  status: string;
  amount: string;
  currency: string;
}

/**
 * Payments read and write.
 *
 * ## Concurrency is settled here, not in the service
 *
 * Two rules are enforced by the database, and the service's job is to *react* to them
 * rather than to prevent them:
 *
 * - `payments_one_pending_per_order_key` — a partial unique index on `order_id WHERE
 *   status = 'PENDING'`. One order can only have one live attempt, so two simultaneous
 *   requests for the same order cannot both reach PayWay. The loser's insert raises
 *   `P2002` and it returns the winner's payment instead.
 * - `payments_transaction_id_key` — plain unique on `transaction_id`. Two attempts can
 *   only collide here if the generator produced the same id twice, which is a real
 *   (if remote) possibility under concurrency and is the reason
 *   {@link PaymentRepository.createPending} distinguishes the two conflicts.
 *
 * Both are partial-to-index rather than application logic because application logic
 * cannot see two concurrent requests; only the database can.
 */
@Injectable()
export class PaymentRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `work` in one interactive transaction.
   *
   * Exists so confirming a payment can promote the order in the same transaction as
   * the `PAID` write — see {@link OrderRepository.confirmPaid} for why those two must
   * not be separable.
   */
  runInTransaction<T>(
    work: (tx: PaymentTransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(work);
  }

  /**
   * Returns an order's single live attempt, or `null`.
   *
   * This is the fast path of `POST /orders/:orderId/payments`: a customer who taps
   * "pay" twice, or whose client retries after a dropped response, gets the QR they
   * already have instead of a second PayWay transaction. It is safe to call
   * optimistically — see {@link createPending} for how a race between this read and the
   * following insert is resolved.
   */
  findPendingByOrderId(
    orderId: string,
    client: PaymentTransactionClient = this.prisma,
  ): Promise<Payment | null> {
    return client.payment.findFirst({
      where: { orderId, status: PAYMENT_STATUS.PENDING },
    });
  }

  /**
   * Returns the attempt carrying `transactionId`, whatever its status.
   *
   * Backed by the unique index rather than a filter, so this is a single-point lookup
   * and the only way the callback handler can start from a specific payment.
   */
  findByTransactionId(
    transactionId: string,
    client: PaymentTransactionClient = this.prisma,
  ): Promise<Payment | null> {
    return client.payment.findUnique({ where: { transactionId } });
  }

  /**
   * Returns one of an order's attempts by its id, for reads that must be scoped by
   * order rather than by provider transaction.
   */
  findById(
    id: string,
    client: PaymentTransactionClient = this.prisma,
  ): Promise<Payment | null> {
    return client.payment.findUnique({ where: { id } });
  }

  /**
   * Inserts a `PENDING` attempt.
   *
   * Rejects with Prisma's `P2002` on either unique index, and the two are
   * distinguishable by the constraint named in `meta.target`:
   *
   * - the **order** index means another request for this order won the race. That is
   *   the expected outcome of a concurrent duplicate, and the caller should re-read
   *   {@link findPendingByOrderId} and return the winner.
   * - the **transaction id** index means the generator collided, which is a genuine
   *   (remote) defect and should be retried with a fresh id.
   *
   * Left to raise rather than translated here: only the caller knows which of the two it
   * can recover from, and a repository that silently resolved both would make the
   * transaction-id case look like a duplicate request.
   *
   * `qrPayload` is absent from `data` for the same reason it is nullable — the row
   * exists before PayWay has been asked.
   */
  createPending(
    data: CreatePaymentData,
    client: PaymentTransactionClient = this.prisma,
  ): Promise<Payment> {
    return client.payment.create({
      data: {
        orderId: data.orderId,
        provider: data.provider,
        transactionId: data.transactionId,
        status: data.status,
        amount: data.amount,
        currency: data.currency,
      },
    });
  }

  /**
   * Stores PayWay's QR on an attempt that is still `PENDING`.
   *
   * Guarded by status for the same reason the order promotion is: if the customer
   * somehow paid and the callback landed *before* this call returned, the attempt is
   * already `PAID` and must not be dragged back to `PENDING`. Updating an unguarded row
   * here would resurrect a completed payment.
   *
   * `updateMany` rather than `update` for the same reason it returns a count: the caller
   * needs to know whether the QR was stored, because "no" means the row moved on and
   * there is nothing left to attach.
   */
  async attachQrPayload(
    id: string,
    qrPayload: PaymentQrPayload,
    client: PaymentTransactionClient = this.prisma,
  ): Promise<boolean> {
    const updated = await client.payment.updateMany({
      where: { id, status: PAYMENT_STATUS.PENDING },
      data: { qrPayload },
    });

    return updated.count === 1;
  }

  /**
   * Marks an attempt `FAILED`.
   *
   * Guarded on `PENDING` so a failure cannot overwrite a `PAID` row. The QR is left in
   * place: it is what the customer was shown, and clearing it would make the response
   * to a duplicate request — which reads this same row — lose the QR the customer is
   * still looking at. The status is the authoritative signal that it is no longer
   * payable, and `POST /orders/:orderId/payments` refuses a failed attempt and starts a
   * fresh one.
   */
  async markFailed(
    id: string,
    client: PaymentTransactionClient = this.prisma,
  ): Promise<boolean> {
    const updated = await client.payment.updateMany({
      where: { id, status: PAYMENT_STATUS.PENDING },
      data: { status: PAYMENT_STATUS.FAILED },
    });

    return updated.count === 1;
  }

  /**
   * Marks an attempt `PAID`, recording what the provider reported.
   *
   * Takes a transaction client because this write and the order's promotion must commit
   * together: see {@link OrderRepository.confirmPaid}.
   *
   * Guarded on a status that is not already `PAID` and returns whether it was the
   * writer. That gives the callback handler idempotency for free — the second of two
   * concurrent deliveries of the same payment matches zero rows, and having already
   * confirmed the order, simply reports success to PayWay.
   *
   * The guard is `not: 'PAID'` rather than `= 'PENDING'` on purpose. PayWay's answer is
   * the authority on whether money moved, so a late callback that verifies a payment we
   * had written off as `FAILED` or `EXPIRED` must still be able to record the truth.
   * (The common case is unaffected: the customer is only ever shown a QR while the
   * attempt is `PENDING`, so a callback for a non-`PENDING` attempt is already rare, and
   * when it happens money really has moved.)
   *
   * **No amount is written.** The column holds what the order charged, recorded at
   * creation from the order row, and `PaymentsService` has just compared PayWay's figure
   * against it. Rewriting it with the value that was verified — or, in a future caller,
   * with the provider's figure — would turn the audit trail into two numbers and let a
   * mismatch overwrite the very value it was checked against.
   */
  async markPaid(
    id: string,
    verified: {
      paymentMethod?: string;
      providerReference?: string;
      paidAt?: Date;
    },
    client: PaymentTransactionClient,
  ): Promise<boolean> {
    const updated = await client.payment.updateMany({
      where: { id, status: { not: PAYMENT_STATUS.PAID } },
      data: {
        status: PAYMENT_STATUS.PAID,
        paidAt: verified.paidAt ?? new Date(),
        ...(verified.paymentMethod === undefined
          ? {}
          : { paymentMethod: verified.paymentMethod }),
        ...(verified.providerReference === undefined
          ? {}
          : { providerReference: verified.providerReference }),
      },
    });

    return updated.count === 1;
  }
}
