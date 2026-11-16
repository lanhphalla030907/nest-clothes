import { createECDH } from 'node:crypto';

/**
 * VAPID settings read once at startup.
 *
 * The private key is stored as a non-enumerable property so accidental
 * serialisation of the settings object (a debug log, an error dump) cannot
 * print it. Nothing in this module ever logs or returns the private key.
 */

export const VAPID_SETTINGS = 'VAPID_SETTINGS' as const;

export interface VapidSettings {
  /** Base64URL-encoded public key, safe to return to clients. */
  readonly publicKey: string | null;
  /** True when all required values are present and the key pair is consistent. */
  readonly configured: boolean;
  /** `mailto:` or `https:` subject string used in VAPID identification. */
  readonly subject: string | null;
}

const readNonEmpty = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/** Shortest base64url-encoded P-256 private key (32 bytes). */
const MIN_PRIVATE_KEY_LEN = 43;
/** Shortest base64url-encoded P-256 uncompressed public key (65 bytes). */
const MIN_PUBLIC_KEY_LEN = 87;

const isValidSubject = (subject: string | null): boolean => {
  if (subject === null) return false;
  return subject.startsWith('mailto:') || subject.startsWith('https://');
};

const isValidBase64Url = (value: string): boolean => {
  if (/[^A-Za-z0-9_-]/.test(value)) return false;
  try {
    Buffer.from(value, 'base64url');
    return true;
  } catch {
    return false;
  }
};

/**
 * Derives the P-256 public key from a base64url-encoded private key and
 * compares it to the supplied base64url-encoded public key. Returns true when
 * the pair is consistent.
 */
const keyPairMatches = (
  privateKeyB64Url: string,
  publicKeyB64Url: string,
): boolean => {
  try {
    const ecdh = createECDH('prime256v1');

    const privateKeyBuffer = Buffer.from(privateKeyB64Url, 'base64url');
    if (privateKeyBuffer.length !== 32) return false;

    ecdh.setPrivateKey(privateKeyBuffer);
    const derivedPublic = ecdh.getPublicKey(null, 'uncompressed');

    const publicKeyBuffer = Buffer.from(publicKeyB64Url, 'base64url');
    if (
      publicKeyBuffer.length !== 33 &&
      publicKeyBuffer.length !== 65
    ) {
      return false;
    }

    return derivedPublic.equals(publicKeyBuffer);
  } catch {
    return false;
  }
};

export const readVapidSettings = (
  env: NodeJS.ProcessEnv = process.env,
): VapidSettings => {
  const publicKey = readNonEmpty(env.VAPID_PUBLIC_KEY);
  const privateKey = readNonEmpty(env.VAPID_PRIVATE_KEY);
  const subject = readNonEmpty(env.VAPID_SUBJECT);

  let configured = false;

  if (publicKey !== null && privateKey !== null && subject !== null) {
    const keysWellFormed =
      isValidBase64Url(publicKey) &&
      isValidBase64Url(privateKey) &&
      publicKey.length >= MIN_PUBLIC_KEY_LEN &&
      privateKey.length >= MIN_PRIVATE_KEY_LEN;

    if (
      keysWellFormed &&
      isValidSubject(subject) &&
      keyPairMatches(privateKey, publicKey)
    ) {
      configured = true;
    }
  }

  const settings: VapidSettings = {
    publicKey,
    configured,
    subject,
  };

  Object.defineProperty(settings, 'privateKeyPlaceholder', {
    value: privateKey,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return Object.freeze(settings);
};

/** Internal accessor for the private key, used only by the push worker (Phase 2C). */
export const getVapidPrivateKey = (settings: VapidSettings): string | null => {
  return (settings as unknown as { privateKeyPlaceholder?: string | null })
    .privateKeyPlaceholder ?? null;
};
