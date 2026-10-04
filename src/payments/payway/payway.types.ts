import { Prisma } from '../../generated/prisma/client.js';

/**
 * The shape of PayWay's HTTP API as this integration needs it, plus the *safe* results
 * that leave the service.
 *
 * Split deliberately in two. Everything under "wire" describes what PayWay sends and
 * is therefore untrusted, loosely typed and validated at the edge by
 * {@link PaywayService}; everything under "result" is what this application is willing
 * to reason about. No wire type is exported past the service, which is what stops a
 * provider field from being spread into a DTO by accident.
 */

/**
 * The minimal `fetch` surface this integration uses.
 *
 * Structural rather than `typeof fetch` on purpose: a test supplies a two-line object
 * instead of stubbing a global, and `Response` from Node satisfies it unchanged.
 */
export interface PaywayHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/** Performs one PayWay call. Injected so tests never touch the network. */
export type PaywayHttpClient = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<PaywayHttpResponse>;

/** Injection token for {@link PaywayHttpClient}. */
export const PAYWAY_HTTP_CLIENT = Symbol('PAYWAY_HTTP_CLIENT');

/**
 * A PayWay `status` block.
 *
 * `code` is a string in both endpoints' success case (`"0"` and `"00"`) and PayWay
 * documents several of its failure codes as numbers, so it is typed as a union of
 * string and number rather than forced into one. Comparing it with `===` against a
 * string would then correctly fail for a numeric code instead of accidentally
 * succeeding through coercion.
 */
export interface PaywayStatusBlock {
  code?: string | number;
  message?: string;
  trace_id?: string;
  /** Only present on `check-transaction-2`. */
  tran_id?: string;
}

/** Everything `generate-qr` can return. All optional: it is untrusted input. */
export interface PaywayGenerateQrWireResponse {
  status?: PaywayStatusBlock;
  amount?: number | string;
  currency?: string;
  qrString?: string;
  qrImage?: string;
  abapay_deeplink?: string;
  app_store?: string;
  play_store?: string;
}

/** The `data` block of a `check-transaction-2` response. */
export interface PaywayCheckTransactionData {
  payment_status_code?: number;
  payment_status?: string;
  total_amount?: number | string;
  original_amount?: number | string;
  payment_amount?: number | string;
  payment_currency?: string;
  refund_amount?: number | string;
  discount_amount?: number | string;
  apv?: string;
  transaction_date?: string;
}

export interface PaywayCheckTransactionWireResponse {
  status?: PaywayStatusBlock;
  data?: PaywayCheckTransactionData;
}

/** What `generateQr` returns: the provider's QR, and nothing about our credentials. */
export interface PaywayQrResult {
  /** The EMV/KHQR payload the customer scans. Always present; PayWay sends it or fails. */
  qrString: string;
  /** Base64 `data:image/png` rendering, when PayWay supplies one. */
  qrImage?: string;
  /** Deep link that opens ABA Mobile directly, when PayWay supplies one. */
  abapayDeeplink?: string;
  /** The lifetime the QR was minted with, echoed for the client to count down. */
  lifetimeMinutes: number;
}

/**
 * What `checkTransaction` returns: the provider's *claim* about a transaction.
 *
 * This is still not a fact. `PaymentsService` compares every field here against what
 * *we* stored before it acts on any of it, which is the whole reason the amounts are
 * `Decimal` and not `number`.
 */
export interface PaywayTransactionCheck {
  paymentStatusCode: number;
  paymentStatus: string;
  /** Amount the customer was required to pay, as PayWay reports it. */
  totalAmount: Prisma.Decimal;
  /** Amount actually taken, as PayWay reports it. */
  paymentAmount: Prisma.Decimal;
  /** Currency the payment settled in, which need not be the currency charged. */
  paymentCurrency: string;
  /** The provider's approval code, kept as the payment's provider reference. */
  apv?: string;
  transactionDate?: string;
}

/** `Prisma.Decimal` from an untrusted JSON number or string, or `null` if unusable. */
export function toDecimalOrNull(
  value: number | string | undefined,
): Prisma.Decimal | null {
  if (value === undefined || value === null) {
    return null;
  }

  try {
    // `String(value)` first: a JSON number has already passed through a double, and
    // constructing a Decimal from it directly would inherit that binary error. Going
    // through its decimal string form gives the digits PayWay meant.
    const decimal = new Prisma.Decimal(String(value));

    return decimal.isFinite() ? decimal : null;
  } catch {
    return null;
  }
}
