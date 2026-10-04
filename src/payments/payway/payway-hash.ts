import { createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client.js';
import {
  PAYWAY_CURRENCIES,
  PAYWAY_MAX_TRANSACTION_ID_LENGTH,
  type PaywayCurrency,
} from './payway.constants.js';

/**
 * PayWay request signing, and the amount formatting that has to agree with it.
 *
 * Pure functions with no I/O, deliberately isolated from the service that makes HTTP
 * calls: the hash is the one piece of this integration that cannot be verified by
 * reading a response, so it gets its own tests and its own file.
 *
 * ## The signing scheme
 *
 * PayWay authenticates a request with an HMAC-SHA512 of the request's own parameter
 * values concatenated in a fixed order, keyed by the merchant's API key, and
 * Base64-encoded. Its documented sample is:
 *
 * ```php
 * $b4hash = $a . $b . $c;
 * $hash   = base64_encode(hash_hmac('sha512', $b4hash, $api_key, true));
 * ```
 *
 * Two properties of that scheme drive this implementation:
 *
 * 1. **Concatenation, not serialisation.** There is no separator, no key names and no
 *    JSON. Values are joined exactly as they are sent, so a field that is omitted
 *    contributes an **empty string** rather than being skipped — skipping it would
 *    silently shift every later value left and produce a hash PayWay cannot
 *    reproduce.
 * 2. **The signed amount must be byte-identical to the sent amount.** PayWay
 *    recomputes the hash from what it received, so signing `"129.00"` and sending
 *    `129` is a hash mismatch and a `1 Wrong Hash` rejection. That is why
 *    {@link formatPaywayAmount} is used for *both* the request body and the hash
 *    input, rather than the body's own `JSON.stringify` being trusted to agree.
 *
 * ## Field order
 *
 * PayWay's parameter *table* order differs from its *hash* order, and its own
 * documentation calls this out. The order below is the hash order, which is:
 *
 * ```
 * req_time, merchant_id, tran_id, amount, items, first_name, last_name, email,
 * phone, purchase_type, payment_option, callback_url, return_deeplink, currency,
 * custom_fields, return_params, payout, lifetime, qr_image_template
 * ```
 *
 * Note where `currency` sits: **after** `return_deeplink`, not next to `amount`.
 * Signing it next to `amount` — which is where a reader would put it — yields a
 * perfectly well-formed hash of the wrong string.
 */

/** The `generate-qr` parameters that are signed, in PayWay's hash order. */
export interface PaywayQrSignable {
  reqTime: string;
  merchantId: string;
  transactionId: string;
  /** Already formatted by {@link formatPaywayAmount}. */
  amount: string;
  currency: string;
  paymentOption: string;
  /** PayWay wants the lifetime as a bare number with no unit. */
  lifetimeMinutes: number;
  qrImageTemplate: string;
  /** Base64-encoded. Empty string when absent. */
  items: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  purchaseType: string;
  /** Base64-encoded. Empty string when absent. */
  callbackUrl: string;
  /** Base64-encoded. Empty string when absent. */
  returnDeeplink: string;
  /** Base64-encoded. Empty string when absent. */
  customFields: string;
  returnParams: string;
  /** Base64-encoded. Empty string when absent. */
  payout: string;
}

/**
 * `Base64(HMAC-SHA512(apiKey, <fields in PayWay's hash order>))`.
 *
 * `digest('base64')` is the Node equivalent of PHP's `base64_encode(hash_hmac(...,
 * true))`: the `true` is what makes PHP emit raw bytes rather than hex, which is why
 * the encoding is Base64 at all.
 */
export function signPaywayQrRequest(
  apiKey: string,
  fields: PaywayQrSignable,
): string {
  return signPayway(apiKey, [
    fields.reqTime,
    fields.merchantId,
    fields.transactionId,
    fields.amount,
    fields.items,
    fields.firstName,
    fields.lastName,
    fields.email,
    fields.phone,
    fields.purchaseType,
    fields.paymentOption,
    fields.callbackUrl,
    fields.returnDeeplink,
    fields.currency,
    fields.customFields,
    fields.returnParams,
    fields.payout,
    String(fields.lifetimeMinutes),
    fields.qrImageTemplate,
  ]);
}

/**
 * `Base64(HMAC-SHA512(apiKey, req_time + merchant_id + tran_id))`.
 *
 * The verification endpoint signs three values, not nineteen. Signing it the way
 * `generate-qr` is signed is the most likely way to get a `5 Invalid hash` back and
 * conclude the transaction is unfindable.
 */
export function signPaywayCheckTransactionRequest(
  apiKey: string,
  fields: { reqTime: string; merchantId: string; transactionId: string },
): string {
  return signPayway(apiKey, [
    fields.reqTime,
    fields.merchantId,
    fields.transactionId,
  ]);
}

/**
 * Compares two hashes without leaking their contents through timing.
 *
 * PayWay does not send a signature on the callback webhook, so this is not used to
 * authenticate an inbound request today. It exists because the temptation to
 * `===` two hashes is exactly what a future callback-signature field would meet, and
 * a timing-safe comparison is the only correct answer when the answer can be
 * observed a character at a time.
 */
export function hashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');

  // `timingSafeEqual` throws on a length mismatch, so unequal lengths are answered
  // separately. That leaks only the length, which is not a secret.
  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(a, b);
}

/** Signs already-ordered values, joined with no separator. */
function signPayway(apiKey: string, values: readonly string[]): string {
  return createHmac('sha512', apiKey)
    .update(values.join(''), 'utf8')
    .digest('base64');
}

/**
 * The amount exactly as PayWay must receive *and* sign it.
 *
 * PayWay's own description of `amount` is inconsistent — the table types it as a number
 * while the integration notes describe a formatted decimal string — and the KHQR
 * guideline is explicit that KHR carries no decimal places. Both are honoured:
 *
 * | currency | rendering      | `129` becomes |
 * | -------- | -------------- | ------------- |
 * | `USD`    | two decimals   | `"129.00"`    |
 * | `KHR`    | whole riel     | `"129"`       |
 *
 * Accepts a {@link Prisma.Decimal}, a string or a number and normalises through
 * `Decimal`, so a caller cannot bypass the exactness by passing a value of another type.
 * A `number` has already lost precision by the time it arrives, which is precisely why
 * `orders.total_amount` is never converted to one on the way here.
 *
 * @throws Error when the currency is one PayWay does not accept, when the amount is not
 *   positive, or when it is below PayWay's minimum for the currency. Rejecting locally
 *   is the point: the same conditions from PayWay arrive as an opaque `12`, whereas here
 *   they can be a 422 that names the order as unpayable and tells an operator exactly
 *   which rule was broken.
 */
export function formatPaywayAmount(
  amount: Prisma.Decimal | string | number,
  currency: string,
): string {
  const code = currency.toUpperCase();

  if (!isSupportedCurrency(code)) {
    throw new Error(`Unsupported PayWay currency: ${currency}`);
  }

  // Re-asserted as the narrowed type: `isSupportedCurrency` is a plain boolean check, so
  // TypeScript cannot see that it excluded everything outside the map. The cast is safe
  // because the throw above already returned for every other value.
  const paywayCurrency: PaywayCurrency = code as PaywayCurrency;

  const decimal =
    amount instanceof Prisma.Decimal ? amount : new Prisma.Decimal(amount);

  if (!decimal.isFinite()) {
    throw new Error(`Amount is not a finite number: ${decimal.toString()}`);
  }

  if (!decimal.isPositive()) {
    throw new Error(`Amount must be greater than zero, received ${decimal.toString()}`);
  }

  const minimum = new Prisma.Decimal(PAYWAY_CURRENCIES[paywayCurrency].minimum);

  if (decimal.lessThan(minimum)) {
    throw new Error(
      `Amount ${decimal.toString()} ${code} is below the PayWay minimum of ${minimum.toString()}`,
    );
  }

  // KHR is a whole-unit currency in PayWay's API — the riel is not divisible — so a
  // fractional total has no wire representation.
  //
  // It is **rejected** rather than rounded, and that distinction is the whole point. The
  // amount returned here is used twice: once in the request PayWay charges, and once as
  // the expectation `PaymentsService` later compares PayWay's answer against. Rounding
  // `45000.67` to `45001` would collect a *different* amount than the order charges, and
  // the callback would then compare PayWay's honest `45001` against the stored
  // `45000.67`, mismatch, and refuse forever — the customer has paid and the order can
  // never be confirmed. Refusing up front is the honest answer: this order total cannot
  // be paid through PayWay.
  if (paywayCurrency === 'KHR' && !decimal.isInteger()) {
    throw new Error(
      `Amount ${decimal.toString()} KHR is not a whole number of riel, which is the only form PayWay accepts`,
    );
  }

  return paywayCurrency === 'KHR' ? decimal.toFixed(0) : decimal.toFixed(2);
}

/**
 * Whether PayWay accepts this currency at all.
 *
 * **Case-sensitive on purpose.** `PAYWAY_CURRENCIES` holds the codes PayWay documents
 * in upper case, and PayWay compares them the same way — so accepting `usd` here would
 * promise a currency this integration cannot actually charge. The database enforces the
 * same rule on `orders.currency` (`^[A-Z]{3}$`), so nothing legitimate arrives in
 * another case; {@link formatPaywayAmount} normalises before checking purely so a
 * hand-written call cannot be tripped up by it.
 */
export function isSupportedCurrency(currency: string): boolean {
  return Object.hasOwn(PAYWAY_CURRENCIES, currency);
}

/**
 * Characters PayWay allows in `tran_id`.
 *
 * A permissive-but-safe class rather than this project's own generated shape, because
 * this function's job is "could this string plausibly be a provider transaction id",
 * not "did we write it". Hard-coding `^PW\d{12}[A-Z0-9]{6}$` would reject a legitimate id
 * if the format were ever changed, and would make the format two sources of truth.
 *
 * The real reason it is not `.{1,20}`: this validates an **unauthenticated** value from
 * the webhook before it reaches the database. Allowing spaces, quotes or control
 * characters through would put junk into a `findUnique` and, more importantly, make this
 * look like a format check when it is only a length check.
 */
const PAYWAY_TRANSACTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;

/**
 * Whether `transactionId` could be a PayWay `tran_id`: 1–20 safe characters.
 *
 * `payments.transaction_id` is the same width, so this is also a guard on the
 * *generator* — a value that failed here would be rejected by the database at insert
 * time, which is a worse place to discover it.
 */
export function isValidPaywayTransactionId(transactionId: string): boolean {
  return (
    transactionId.length <= PAYWAY_MAX_TRANSACTION_ID_LENGTH &&
    PAYWAY_TRANSACTION_ID_PATTERN.test(transactionId)
  );
}

/**
 * `req_time`: UTC as `YYYYMMDDHHmmss`, which is what PayWay documents.
 *
 * UTC in particular, and not the server's local time: PayWay validates the window,
 * so a box in UTC+7 would have its requests rejected for being seven hours in the
 * future. `toISOString` is UTC by definition, which is why it is used rather than
 * any local-time formatter.
 */
export function formatPaywayRequestTime(now: Date = new Date()): string {
  return now.toISOString().replace(/\D/g, '').slice(0, 14);
}

/**
 * UTF-8 is stated explicitly on the *encoding* side because Node's default for
 * `Buffer.from(string)` is utf8 anyway: an argument dropped by accident during a
 * refactor would still compile, and only fail for the non-ASCII customer names
 * PayWay accepts.
 */
export function encodePaywayBase64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}
