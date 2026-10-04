import { toMoneyString } from '../../common/utils/money.js';
import type { Payment } from '../../generated/prisma/client.js';
import type { PaymentQrPayload } from '../repositories/payment.repository.js';

/**
 * What `POST /orders/:orderId/payments` returns.
 *
 * ## The safe set, and why it is safe
 *
 * Every field here is something the *client* legitimately needs in order to show a
 * checkout: which payment this is, which order it is paying, what PayWay called it,
 * what state it is in, the amount being collected, and the QR itself.
 *
 * What is **not** here is the point of the type:
 *
 * - no `hash`, `apiKey` or any other credential-derived value;
 * - no raw PayWay response body, so a future PayWay field cannot reach a client by
 *   default;
 * - no `userId` — the response is addressed to the order's owner and echoing their own
 *   identity back adds nothing;
 * - no internal `provider` routing detail beyond the provider *name*, which the client
 *   needs to know it is looking at an ABA PayWay QR.
 *
 * Because it is an explicit projection rather than a raw entity or a spread, adding a
 * column to `payments` — an internal note, a raw callback body, anything — cannot
 * publish it. That is the difference between this and returning `Payment` directly.
 *
 * ## All money is a string
 *
 * `amount` is rendered with the currency's own precision by the service and carried as
 * a string, never a number. JSON numbers are doubles, and a client that re-parsed
 * `12.30` into a float and printed `12.3` has a receipt that disagrees with ours.
 * `Prisma.Decimal` on the server and a string on the wire is what makes the two agree
 * exactly.
 */
export class PaymentResponseDto {
  /** This payment attempt's id. */
  paymentId: string;

  /** The order being paid. */
  orderId: string;

  /** PayWay's `tran_id`. Shown to support, and echoed for reconciliation. */
  transactionId: string;

  /**
   * `PENDING`, `PAID`, `FAILED` or `EXPIRED`.
   *
   * `PENDING` with a QR is the only combination that means "scan this".
   */
  status: string;

  /** Amount being collected, formatted for {@link currency} and sent as a string. */
  amount: string;

  /** ISO 4217 code the amount is in. Never something the client chose. */
  currency: string;

  /** PayWay's KHQR payload — the string the customer's banking app reads. */
  qrString: string;

  /** PayWay's PNG rendering of {@link qrString}, when supplied. */
  qrImage?: string;

  /** Deep link that opens ABA Mobile directly, when supplied. */
  abapayDeeplink?: string;

  /** QR lifetime in minutes, so the client can count down instead of guessing. */
  lifetimeMinutes?: number;

  /** When the QR stops working, ISO-8601. */
  expiresAt?: string;

  /**
   * Projects a payment row into the response.
   *
   * `qrString` is required on the DTO but optional on the row: the row is written
   * before PayWay is called. A caller must therefore have the stored QR in hand —
   * which is exactly the guarantee `attachQrPayload` gives, and why this method takes
   * the payload it just stored rather than re-reading the row and hoping.
   *
   * Key by key rather than spread, so a new column on `payments` has to be added here
   * deliberately — that deliberation *is* the security property.
   */
  static fromEntity(
    payment: Payment,
    qrPayload: PaymentQrPayload | null,
  ): PaymentResponseDto {
    const dto = new PaymentResponseDto();

    dto.paymentId = payment.id;
    dto.orderId = payment.orderId;
    dto.transactionId = payment.transactionId;
    dto.status = payment.status;
    // Rendered with the project's shared money formatter rather than interpolated, so a
    // `Decimal` never reaches the wire as a JSON double.
    dto.amount = toMoneyString(payment.amount);
    dto.currency = payment.currency;

    if (qrPayload !== null) {
      dto.qrString = qrPayload.qrString;

      if (qrPayload.qrImage !== undefined) {
        dto.qrImage = qrPayload.qrImage;
      }

      if (qrPayload.abapayDeeplink !== undefined) {
        dto.abapayDeeplink = qrPayload.abapayDeeplink;
      }

      if (qrPayload.lifetimeMinutes !== undefined) {
        dto.lifetimeMinutes = qrPayload.lifetimeMinutes;
      }

      if (qrPayload.expiresAt !== undefined) {
        dto.expiresAt = qrPayload.expiresAt;
      }
    }

    return dto;
  }
}
