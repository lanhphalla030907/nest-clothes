import { CLOUDINARY_ENV_VARS } from './cloudinary.constants.js';

/**
 * Resolved Cloudinary credentials, safe to hold in memory and to pass to the SDK.
 *
 * `apiSecret` is `readonly` and the shape has no `toJSON`, so the one realistic
 * way to leak it — an accidental `JSON.stringify` of configuration, or a logger
 * that dumps a provider's dependencies — is closed off by the type as well as by
 * the `toJSON` below.
 */
export interface CloudinaryCredentials {
  readonly cloudName: string;
  readonly apiKey: string;
  readonly apiSecret: string;
}

/**
 * Reads Cloudinary credentials from the environment and validates them.
 *
 * Fails loudly and immediately rather than deferring: `CloudinaryService` cannot
 * do anything useful without all three values, and discovering that on the first
 * upload would surface as a confusing runtime failure during a user request
 * rather than as a startup error an operator can act on.
 *
 * ## Secret handling
 *
 * The thrown error names the *missing variable* and never its value, and the
 * validation never echoes a supplied value back — not even a truncated one. An
 * error message routinely ends up in a log file or an error tracker, so the only
 * safe content is the variable's name.
 *
 * @throws Error listing every missing variable, with no credential values.
 */
export function readCloudinaryCredentials(
  env: NodeJS.ProcessEnv = process.env,
): CloudinaryCredentials {
  const missing: string[] = [];

  const cloudName = env[CLOUDINARY_ENV_VARS.cloudName];
  const apiKey = env[CLOUDINARY_ENV_VARS.apiKey];
  const apiSecret = env[CLOUDINARY_ENV_VARS.apiSecret];

  if (isBlank(cloudName)) {
    missing.push(CLOUDINARY_ENV_VARS.cloudName);
  }

  if (isBlank(apiKey)) {
    missing.push(CLOUDINARY_ENV_VARS.apiKey);
  }

  if (isBlank(apiSecret)) {
    missing.push(CLOUDINARY_ENV_VARS.apiSecret);
  }

  if (missing.length > 0) {
    throw new Error(
      `Cloudinary is not configured: missing required environment variable(s) ${missing.join(', ')}. ` +
        `Set them in the environment (see .env.example); values must not be committed.`,
    );
  }

  /**
   * Narrowed by the checks above. The non-null assertions are safe because
   * `missing.length === 0` proves none of the three was blank, and `isBlank`
   * only rejects `undefined`, `null` and whitespace-only strings.
   */
  return Object.freeze({
    cloudName: cloudName as string,
    apiKey: apiKey as string,
    apiSecret: apiSecret as string,
  });
}

/**
 * Whether a configuration variable is effectively absent.
 *
 * An empty string and a whitespace-only string are both treated as missing: a
 * blank value in a `.env` file is almost always a mistake, and failing with
 * "missing" is far more actionable than Cloudinary rejecting an empty credential
 * with an opaque 401 on the first upload.
 */
function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}
