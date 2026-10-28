/**
 * Environment variable names read by {@link readJwtSettings}.
 *
 * Names only — a value is never stored here, and nothing in this file is ever
 * logged or returned to a client.
 */
export const JWT_ENV_VARS = {
  secret: 'JWT_ACCESS_SECRET',
  expiresIn: 'JWT_ACCESS_EXPIRES_IN',
  issuer: 'JWT_ISSUER',
  audience: 'JWT_AUDIENCE',
} as const;

/** Applied when `JWT_ACCESS_EXPIRES_IN` is absent. */
export const DEFAULT_JWT_EXPIRES_IN = '15m';

/** Applied when `JWT_ISSUER` is absent. */
export const DEFAULT_JWT_ISSUER = 'clothes-ecommerce-api';

/** Applied when `JWT_AUDIENCE` is absent. */
export const DEFAULT_JWT_AUDIENCE = 'clothes-ecommerce-clients';

/**
 * Injection token for {@link JwtSettings}.
 *
 * A symbol for the same reason `PAYWAY_CONFIG` is one: the resolved settings are a
 * plain frozen object, so `import type` would erase the token at runtime.
 */
export const JWT_SETTINGS = Symbol('JWT_SETTINGS');

/** A duration accepted for `JWT_ACCESS_EXPIRES_IN` — a number, or `ms`-style suffixed. */
const DURATION_PATTERN = /^\d+(?:\.\d+)?\s*(?:ms|s|m|h|d|w|y)?$/i;

/**
 * Whether a configured lifetime is usable.
 *
 * Rejecting nonsense here turns `JWT_ACCESS_EXPIRES_IN=nonsense` into a startup
 * failure naming the variable, rather than a 500 on the first login caused by an
 * opaque error from the JWT library.
 */
export function isValidDuration(value: string): boolean {
  return DURATION_PATTERN.test(value);
}
