import { Expose } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Input contract for `POST /orders/:orderId/payments`.
 *
 * ## The body is empty, on purpose
 *
 * There is no field to populate, and that is the whole security property of this
 * endpoint. A payment is an attempt to collect **the order's own total, in the
 * order's own currency** — both of which already exist as columns on `orders` and both
 * of which were computed by checkout from catalogue prices. Accepting either from a
 * client would reopen the bug checkout closed: a request that pays 1.00 for a 129.00
 * order would be a working order-confirmation bypass.
 *
 * So the DTO declares no fields, and the global `ValidationPipe` runs with
 * `forbidNonWhitelisted`. A body of `{}` — or, for a request that sends no body at
 * all, `{}` — validates; a body carrying `amount`, `currency`, `orderId`, `provider`,
 * `status` or `transactionId` is rejected **400 before any code runs**. There is no
 * field to ignore and therefore no field to forget.
 *
 * ## Why `orderId` is not here either
 *
 * It is in the path, and it is not duplicated as an optional field. A DTO that accepted
 * both would have to reconcile them, and every reconciliation rule — "prefer the path",
 * "reject on mismatch" — is a rule someone eventually gets wrong.
 *
 * ## Why this class exists at all
 *
 * Nest accepts a request with no body and no DTO. Declaring an empty DTO and typing
 * `@Body()` with it is what makes the *rejection* of a populated body deliberate: the
 * pipe needs a metatype to validate against, and an absent one would validate nothing
 * and admit whatever arrived.
 */
export class CreatePaymentDto {}

/**
 * Input contract for `POST /payments/aba-payway/callback`.
 *
 * ## Validated by hand, not by the global pipe
 *
 * Every other DTO in this project is enforced by the global `ValidationPipe` with
 * `forbidNonWhitelisted`, which is exactly right for a request a human wrote and
 * disastrous for this one: PayWay decides which keys it sends, and a new field in a
 * future PayWay release would begin producing 400s that stop every customer payment
 * from being recorded. The controller therefore reads the raw body and runs
 * {@link plainToInstance} + `validate` itself with `whitelist: false`, tolerating
 * anything unexpected and ignoring it.
 *
 * ## Nothing in here is trusted
 *
 * Every field is `@IsOptional()` because a webhook that arrives malformed, incomplete
 * or spoofed must reach the service and be *verified against PayWay*, not be turned
 * away at the edge. The one field that identifies the payment —
 * {@link PaywayCallbackDto.transactionId}, sourced from `merchant_ref` — is the only
 * one the service acts on directly, and only to *find* a row; whether that row becomes
 * `PAID` is decided by a server-to-server `check-transaction-2` call, never by
 * anything in this payload.
 *
 * `paymentStatus`, `amount`, `currency` and `hash` exist so a PayWay release that starts
 * sending them is captured rather than dropped, and so {@link PaywayCallbackDto}'s
 * documented contract is complete. They are read only for logging and for the
 * cross-check against the provider's own answer; none of them can move a status.
 */
export class PaywayCallbackDto {
  /**
   * PayWay's echo of the transaction id we generated, which it labels `merchant_ref`.
   *
   * Accepts `transaction_id` as a fallback because PayWay uses that spelling for the
   * same value in some integrations. Both are the *identifier only* — the lookup key.
   */
  @Expose({ name: 'merchant_ref' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  merchantRef?: string;

  /** Alternative spelling of {@link merchantRef}, same meaning. */
  @Expose({ name: 'transaction_id' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  transactionId?: string;

  /**
   * PayWay's own status text, e.g. `APPROVED` or `Pending`.
   *
   * Recorded for diagnostics and compared against the verified answer, but never
   * allowed to conclude a payment: a caller can send `APPROVED` here and PayWay itself
   * will report the transaction as unpaid.
   */
  @Expose({ name: 'payment_status' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  paymentStatus?: string;

  /** PayWay's status code, as a string. Diagnostic only, per the class note. */
  @Expose({ name: 'payment_status_code' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  paymentStatusCode?: string;

  /** Amount PayWay says it collected. Compared, never trusted. */
  @Expose()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  amount?: string;

  /** Currency PayWay says it settled in. Compared, never trusted. */
  @Expose()
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  /** Approval code, when PayWay sends it. Diagnostic only. */
  @Expose({ name: 'apv' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  apv?: string;

  /** PayWay's timestamp for the transaction. Diagnostic only. */
  @Expose({ name: 'transaction_date' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  transactionDate?: string;
}
