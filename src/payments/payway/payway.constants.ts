/**
 * Everything about the ABA PayWay API that is a *fact about the provider* rather
 * than a decision of ours.
 *
 * Collected here so that a change on PayWay's side is one edit in one file, and so
 * that no service hardcodes a URL, a status code or a magic string.
 *
 * ## Sources
 *
 * The endpoints, the request fields, the hash input order and the status vocabularies
 * below are taken from PayWay's published developer documentation:
 *
 * - QR: `POST /api/payment-gateway/v1/payments/generate-qr`
 * - Verification: `POST /api/payment-gateway/v1/payments/check-transaction-2`
 *
 * ## The two success codes are not the same
 *
 * `generate-qr` reports success as the **string** `"0"`, while `check-transaction-2`
 * reports it as the string `"00"`. Both are strings in the JSON, and both endpoints
 * return HTTP 200 for a business-level failure. Comparing either against the
 * other's code is the kind of mistake that silently turns every payment into a
 * "successful" one, so the two constants are named for the endpoint they belong to
 * rather than being a single shared `SUCCESS`.
 */

/** Environment variables the PayWay integration reads. */
export const PAYWAY_ENV_VARS = {
  baseUrl: 'PAYWAY_BASE_URL',
  merchantId: 'PAYWAY_MERCHANT_ID',
  apiKey: 'PAYWAY_API_KEY',
  callbackUrl: 'PAYWAY_CALLBACK_URL',
} as const;

/**
 * The value written to `payments.provider`.
 *
 * A name rather than an enum or a foreign key, matching the rest of this schema: a
 * `provider` column keeps room for the other methods this phase explicitly does not
 * implement (card, cash on delivery) without a migration, and the value is chosen here
 * once so no service can invent its own spelling and strand rows under two names.
 */
export const PAYWAY_PROVIDER_NAME = 'ABA_PAYWAY';

/**
 * Where PayWay's sandbox lives, used when `PAYWAY_BASE_URL` is unset.
 *
 * A default rather than a requirement, and deliberately the only default: it is a
 * public URL and not a credential, and requiring it would mean a developer cannot
 * boot the application before reading the documentation. Production PayWay is out of
 * scope for this phase, so the sandbox is the only endpoint this project addresses;
 * pointing `PAYWAY_BASE_URL` at production later needs no code change.
 */
export const PAYWAY_SANDBOX_BASE_URL = 'https://checkout-sandbox.payway.com.kh';

/** Absolute paths appended to the configured base URL. */
export const PAYWAY_PATHS = {
  generateQr: '/api/payment-gateway/v1/payments/generate-qr',
  checkTransaction: '/api/payment-gateway/v1/payments/check-transaction-2',
} as const;

/** `status.code` value meaning success on `generate-qr`. A *string* `"0"`. */
export const PAYWAY_GENERATE_QR_SUCCESS_CODE = '0';

/** `status.code` value meaning success on `check-transaction-2`. A *string* `"00"`. */
export const PAYWAY_CHECK_TRANSACTION_SUCCESS_CODE = '00';

/**
 * `generate-qr` `status.code` for a transaction id PayWay has already seen.
 *
 * Our own collision protection makes this unreachable in normal operation, because
 * transaction ids are generated here and retried on collision. It is named so that
 * seeing it in a log points at the generator rather than at a client sending a
 * duplicate.
 */
export const PAYWAY_DUPLICATE_TRANSACTION_CODE = '403';

/**
 * `check-transaction-2` `data.payment_status_code`.
 *
 * PayWay sends the numeric code *and* the `payment_status` word; both are checked by
 * {@link PaywayService} because they are two encodings of one fact and either alone
 * would be trusting a single field.
 */
export const PAYWAY_TRANSACTION_STATUS_CODE = {
  /** Funds collected (or a pre-authorisation hold taken). */
  approved: 0,
  /** Awaiting the payer. */
  pending: 2,
  /** Refused by the bank. */
  declined: 3,
  /** Fully or partly given back. */
  refunded: 4,
  /** Closed by the merchant. */
  cancelled: 7,
} as const;

/**
 * `check-transaction-2` `data.payment_status`, the word form of the code above.
 *
 * Only `APPROVED` counts as collected. `PRE-AUTH` is deliberately **not** accepted:
 * it means a hold was placed and the money has not been captured, so confirming an
 * order against it would confirm an order nobody has paid for.
 */
export const PAYWAY_TRANSACTION_STATUS = {
  approved: 'APPROVED',
  preAuth: 'PRE-AUTH',
  refunded: 'REFUNDED',
  pending: 'PENDING',
  declined: 'DECLINED',
  cancelled: 'CANCELLED',
} as const;

/** Currencies PayWay accepts, with the smallest amount it will accept in each. */
export const PAYWAY_CURRENCIES = {
  USD: { minimum: '0.01' },
  KHR: { minimum: '100' },
} as const;

export type PaywayCurrency = keyof typeof PAYWAY_CURRENCIES;

/**
 * The QR flavour requested from PayWay.
 *
 * `abapay_khqr` is the only option that works for both supported currencies, which is
 * why it is a constant rather than a request parameter. WeChat and Alipay are USD
 * only and are not offered by this phase.
 */
export const PAYWAY_PAYMENT_OPTION = 'abapay_khqr';

/**
 * Always a plain purchase, never a pre-authorisation.
 *
 * A pre-auth would put a hold on the customer's funds that only a capture (and so a
 * route this phase does not have) could settle.
 */
export const PAYWAY_PURCHASE_TYPE = 'purchase';

/**
 * How long a generated QR stays payable, in minutes.
 *
 * PayWay accepts 3 minutes to 120 days. This is comfortably inside both, and long
 * enough that a customer who abandons the QR can come back to it within a shopping
 * session. It is a constant because it is a product decision about how long an
 * unpaid attempt stays usable, not a credential or an integration detail.
 */
export const PAYWAY_QR_LIFETIME_MINUTES = 30;

/** PayWay's QR rendering template. Affects only how the QR is drawn. */
export const PAYWAY_QR_IMAGE_TEMPLATE = 'template3_color';

/**
 * PayWay's documented maximum length for `tran_id`.
 *
 * The column is `VARCHAR(20)` to match, so this is enforced by the database as well
 * as by the generator. Storing a wider id and truncating it at the HTTP boundary
 * would let two distinct payments share one provider transaction.
 */
export const PAYWAY_MAX_TRANSACTION_ID_LENGTH = 20;

/**
 * How long to wait for PayWay before giving up, in milliseconds.
 *
 * A payment request that hangs holds a request handler and, for the create-payment
 * path, a `PENDING` row. Bounding the wait is what lets that row be resolved rather
 * than left pending indefinitely.
 */
export const PAYWAY_REQUEST_TIMEOUT_MS = 10_000;
