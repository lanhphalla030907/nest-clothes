import {
  PAYWAY_ENV_VARS,
  PAYWAY_SANDBOX_BASE_URL,
} from './payway.constants.js';

/**
 * Injection token for {@link ResolvedPaywayConfig}.
 *
 * A symbol rather than the type itself: the resolved configuration is a plain frozen
 * object, and `import type` erases a type-only token at runtime, so the module would
 * hand Nest `undefined` to inject against. A `Symbol` is unique by construction, cannot
 * collide with a class token some other module happens to export, and makes the
 * provider's contract greppable.
 */
export const PAYWAY_CONFIG = Symbol('PAYWAY_CONFIG');

/**
 * PayWay settings that are present and validated.
 *
 * `apiKey` is `readonly`, and the shape has no `toJSON`, so the one realistic way to
 * leak it — an accidental `JSON.stringify` of configuration, or a logger dumping a
 * provider's dependencies — is closed off by the type as much as by convention. Same
 * treatment, and for the same reasons, as `CloudinaryCredentials`.
 */
export interface PaywaySettings {
  /** Absolute origin every PayWay path is appended to, without a trailing slash. */
  readonly baseUrl: string;
  /** ABA-assigned merchant key. Not secret, but still never returned to a client. */
  readonly merchantId: string;
  /** HMAC-SHA512 signing key. **Never** logged, returned, or persisted. */
  readonly apiKey: string;
  /** Absolute URL PayWay posts the payment callback to; sent to PayWay Base64-encoded. */
  readonly callbackUrl: string;
}

/**
 * What {@link readPaywayConfig} returns: either a usable configuration, or the reason
 * there isn't one.
 *
 * ## Why a union and not a shape with blanks
 *
 * The obvious design is one object with empty strings for whatever is absent. It is a
 * trap: every consumer then has to remember that `merchantId` being `''` means "the
 * operator has not configured this" rather than "the merchant is the empty string", and
 * the type system will not remind any of them. The failure it invites is the worst kind
 * available here — an unsigned request being sent because a caller forgot a check, or a
 * 502 blaming PayWay for a problem that is in our own environment.
 *
 * So the two states are separate types. {@link ResolvedPaywayConfig.configured} is `true`
 * only when `merchantId`, `apiKey` and `callbackUrl` are all real strings, and only then
 * does {@link PaywaySettings} exist to be used. To make a payment, a caller must first
 * narrow with {@link isPaywayConfigured}, and TypeScript then refuses to let it reach a
 * credential that might be blank.
 */
export type ResolvedPaywayConfig =
  | {
      readonly configured: true;
      readonly settings: PaywaySettings;
      readonly missing: readonly [];
    }
  | {
      readonly configured: false;
      /**
       * Absent entirely, rather than present-and-blank.
       *
       * Keeping the credentials out of the unconfigured variant is what makes the
       * narrowing above sound: there is no `''` anywhere in this shape to be used by
       * mistake. Only the names survive, which is all a log line needs.
       */
      readonly settings?: undefined;
      /**
       * Names of the variables that are missing or unusable, e.g. `['PAYWAY_API_KEY']`.
       *
       * Names only, never values. This field is what makes a misconfiguration
       * diagnosable without ever echoing a credential: a blank value and a correct one
       * differ only in whether the name appears here.
       */
      readonly missing: readonly string[];
    };

/**
 * True when PayWay is configured well enough to attempt a call, narrowing the union.
 *
 * The overloads are the point: `isPaywayConfigured(config)` narrows `config` to the
 * configured variant, and `isPaywayConfigured(config, 'settings')` returns the settings
 * directly. Neither is available for an unconfigured deployment, so a blank merchant id
 * cannot reach a request.
 */
export function isPaywayConfigured(
  config: ResolvedPaywayConfig,
): config is Extract<ResolvedPaywayConfig, { configured: true }>;
export function isPaywayConfigured(
  config: ResolvedPaywayConfig,
  field: 'settings',
): PaywaySettings;
export function isPaywayConfigured(
  config: ResolvedPaywayConfig,
  field?: 'settings',
): boolean | PaywaySettings | undefined {
  if (!config.configured) {
    // `undefined` rather than `false` for the settings overload: the unconfigured variant
    // has no `settings` property at all, so the honest answer to "give me the settings"
    // is "there are none".
    return field === undefined ? false : undefined;
  }

  return field === undefined ? true : config.settings;
}

/**
 * Reads PayWay configuration from the environment and validates it.
 *
 * ## Why this validates instead of throwing
 *
 * The Cloudinary config throws at bootstrap, and for Cloudinary that is right: the
 * application cannot do anything at all without it. PayWay is different. It is one
 * provider behind one route, and this project has to boot, pass its test suite and
 * serve carts and orders in environments that have no ABA credentials — a CI runner has
 * none, and a developer's machine may have none.
 *
 * So configuration is *resolved and validated* here and the missing names are reported
 * rather than thrown. Nothing that could change the meaning of a payment is silently
 * defaulted: `merchantId`, `apiKey` and `callbackUrl` are simply absent, and
 * `PaywayService` refuses to call PayWay while any of them is — with a 503 rather than a
 * payment-shaped answer that might be mistaken for a real refusal. That keeps "not
 * configured" impossible to confuse with "the customer did not pay".
 *
 * `PAYWAY_BASE_URL` *is* defaulted, to the documented sandbox, because it is a public
 * address rather than a credential — so an absent one is **not** a misconfiguration and
 * must not appear in {@link ResolvedPaywayConfig.missing}. A base URL that is present
 * but unusable (`http://`, a relative path, nonsense) *is* reported as missing, because
 * falling back to the sandbox after someone asked for somewhere else would silently send
 * live payment traffic to a test host.
 *
 * ## Secret handling
 *
 * Nothing here throws and nothing here echoes a value — not even a truncated one. An
 * error message routinely ends up in a log file or an error tracker, so the only safe
 * content about a credential is its variable's name.
 */
export function readPaywayConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPaywayConfig {
  const missing: string[] = [];

  // Only a *present but unusable* base URL is a misconfiguration; an absent one takes
  // the documented sandbox default.
  const baseUrl =
    env[PAYWAY_ENV_VARS.baseUrl] === undefined
      ? PAYWAY_SANDBOX_BASE_URL
      : normaliseBaseUrl(env[PAYWAY_ENV_VARS.baseUrl]);

  if (baseUrl === null) {
    missing.push(PAYWAY_ENV_VARS.baseUrl);
  }

  const merchantId = requiredValue(env[PAYWAY_ENV_VARS.merchantId]);
  if (merchantId === null) {
    missing.push(PAYWAY_ENV_VARS.merchantId);
  }

  const apiKey = requiredValue(env[PAYWAY_ENV_VARS.apiKey]);
  if (apiKey === null) {
    missing.push(PAYWAY_ENV_VARS.apiKey);
  }

  const callbackUrl = normaliseCallbackUrl(env[PAYWAY_ENV_VARS.callbackUrl]);
  if (callbackUrl === null) {
    missing.push(PAYWAY_ENV_VARS.callbackUrl);
  }

  if (
    missing.length > 0 ||
    baseUrl === null ||
    merchantId === null ||
    apiKey === null ||
    callbackUrl === null
  ) {
    // The `missing` list is the authoritative content here; the four `null` checks
    // exist only so TypeScript can see that none of them survived. They cannot fail
    // without having pushed a name.
    return Object.freeze({
      configured: false as const,
      missing: Object.freeze(missing),
    });
  }

  return Object.freeze({
    configured: true as const,
    settings: Object.freeze({ baseUrl, merchantId, apiKey, callbackUrl }),
    missing: Object.freeze([]) as readonly [],
  });
}

/**
 * An absolute `https:` origin with no trailing slash, or `null` if unusable.
 *
 * Plain HTTPS is required rather than preferred: the API key's HMAC is in the `hash` of
 * every request, and an `http://` base URL would put a valid signature on the wire in
 * clear for anyone on the path. A non-HTTP scheme (`file:`, `javascript:`) is rejected
 * for the same reason, which is why this parses the URL rather than pattern-matching a
 * prefix.
 */
function normaliseBaseUrl(value: string | undefined): string | null {
  const raw = requiredValue(value);
  if (raw === null) {
    return null;
  }

  const parsed = parseUrl(raw);
  if (parsed === null || parsed.protocol !== 'https:' || parsed.hostname === '') {
    return null;
  }

  // A base URL with a path is tolerated but normalised to its origin, so the documented
  // `/api/...` paths cannot be appended to something that already has one and produce a
  // 404 nobody can explain.
  return parsed.origin;
}

/**
 * An absolute `https:` URL PayWay can POST a callback to, or `null` if unusable.
 *
 * The full URL is kept, not just the origin. PayWay Base64-encodes this value into the
 * request and signs it, so it is part of the merchant's signed configuration; normalising
 * it also means the exact string that is validated is the exact string that is signed.
 */
function normaliseCallbackUrl(value: string | undefined): string | null {
  const raw = requiredValue(value);
  if (raw === null) {
    return null;
  }

  const parsed = parseUrl(raw);
  if (parsed === null || parsed.protocol !== 'https:' || parsed.hostname === '') {
    return null;
  }

  return parsed.toString();
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * A non-blank, trimmed environment value, or `null`.
 *
 * Blank is treated as absent for the same reason `readCloudinaryCredentials` treats it
 * that way: a blank value in a `.env` file is a mistake, and "PAYWAY_API_KEY is missing"
 * is far more actionable than PayWay rejecting an empty key with an opaque error on the
 * first real payment.
 */
function requiredValue(value: string | undefined): string | null {
  if (value === undefined || value.trim().length === 0) {
    return null;
  }

  return value.trim();
}
