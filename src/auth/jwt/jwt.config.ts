import {
  DEFAULT_JWT_AUDIENCE,
  DEFAULT_JWT_EXPIRES_IN,
  DEFAULT_JWT_ISSUER,
  isValidDuration,
  JWT_ENV_VARS,
} from './jwt.constants.js';

/**
 * Resolved JWT settings.
 *
 * `secret` is `readonly` and the object is frozen, so the settings cannot be rewritten
 * after they are validated. That is a *tamper* guarantee, not a confidentiality one: a
 * frozen object still serialises, so anything that stringifies the provider holding
 * these settings would emit the key. `AccessTokenService` therefore keeps them in a `#`
 * private field, which no serialiser can see. Same intent, and the same reasoning, as
 * `CloudinaryCredentials` and `PaywaySettings`.
 */
export interface JwtSettings {
  /** HMAC signing key. **Never** logged, returned, or persisted. */
  readonly secret: string;
  /** Access-token lifetime, e.g. `15m`. */
  readonly expiresIn: string;
  /** `iss` claim, verified on every request. */
  readonly issuer: string;
  /** `aud` claim, verified on every request. */
  readonly audience: string;
}

/**
 * Shortest signing key accepted.
 *
 * HS256 derives its strength from the key length, and 32 characters is the 256-bit
 * minimum OWASP asks for. Anything shorter is refused at startup rather than quietly
 * producing tokens an attacker can brute-force offline.
 */
export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Reads JWT settings from the environment and validates them.
 *
 * Fails loudly at construction, i.e. during bootstrap, so a deployment with no signing
 * key never serves a request — rather than discovering it on the first login.
 *
 * ## Secret handling
 *
 * The thrown error names the *missing* variable and never its value, and validation
 * never echoes a supplied value back — not even truncated. An error message routinely
 * ends up in a log file or an error tracker, so the only safe content is the name.
 *
 * @throws Error naming every missing or unusable variable, with no values.
 */
export function readJwtSettings(
  env: NodeJS.ProcessEnv = process.env,
): JwtSettings {
  const missing: string[] = [];

  const secret = requiredValue(env[JWT_ENV_VARS.secret]);
  if (secret === null || secret.length < MIN_JWT_SECRET_LENGTH) {
    missing.push(JWT_ENV_VARS.secret);
  }

  const expiresIn = requiredValue(env[JWT_ENV_VARS.expiresIn]) ?? DEFAULT_JWT_EXPIRES_IN;
  if (!isValidDuration(expiresIn)) {
    missing.push(JWT_ENV_VARS.expiresIn);
  }

  const issuer = requiredValue(env[JWT_ENV_VARS.issuer]) ?? DEFAULT_JWT_ISSUER;
  const audience = requiredValue(env[JWT_ENV_VARS.audience]) ?? DEFAULT_JWT_AUDIENCE;

  if (missing.length > 0) {
    throw new Error(
      `JWT is not configured: missing or unusable environment variable(s) ${missing.join(', ')}. ` +
        `Set them in the environment (see .env.example); values must not be committed. ` +
        `JWT_ACCESS_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters.`,
    );
  }

  /**
   * Narrowed by the checks above: `missing.length === 0` proves the secret was present
   * and long enough, the duration matched the pattern, and each fallback constant is a
   * valid string.
   */
  return Object.freeze({
    secret: secret as string,
    expiresIn,
    issuer,
    audience,
  });
}

/**
 * A non-blank, trimmed environment value, or `null`.
 *
 * Blank is treated as absent for the same reason `readCloudinaryCredentials` treats it
 * that way: a blank value in a `.env` file is a mistake, and "the variable is missing"
 * is far more actionable than an opaque failure from the JWT library.
 */
function requiredValue(value: string | undefined): string | null {
  if (value === undefined || value.trim().length === 0) {
    return null;
  }

  return value.trim();
}
