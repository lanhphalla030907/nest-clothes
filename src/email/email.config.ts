/**
 * SMTP configuration for transactional email.
 *
 * Email is optional, exactly like PayWay: the application must boot and pass
 * its tests on a machine with no SMTP credentials. The union below makes
 * "configured" a type-level state, so `EmailService` cannot accidentally send
 * with a blank host or a missing sender.
 */

export const MAIL_CONFIG = Symbol('MAIL_CONFIG');
export const MAIL_TRANSPORTER = Symbol('MAIL_TRANSPORTER');

export const MAIL_ENV_VARS = {
  host: 'MAIL_HOST',
  port: 'MAIL_PORT',
  secure: 'MAIL_SECURE',
  user: 'MAIL_USER',
  password: 'MAIL_PASSWORD',
  from: 'MAIL_FROM',
  resetUrl: 'FRONTEND_RESET_URL',
} as const;

export interface MailSettings {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  /** SMTP password. Never logged, returned, or serialised. */
  readonly password: string;
  readonly from: string;
  /** Absolute frontend URL that renders the reset form. */
  readonly resetUrl: string;
}

export type ResolvedMailConfig =
  | {
      readonly configured: true;
      readonly settings: MailSettings;
      readonly missing: readonly [];
    }
  | {
      readonly configured: false;
      readonly settings?: undefined;
      /** Names only, never values. */
      readonly missing: readonly string[];
    };

export function isMailConfigured(
  config: ResolvedMailConfig,
): config is Extract<ResolvedMailConfig, { configured: true }> {
  return config.configured;
}

/**
 * Reads and validates SMTP settings without throwing.
 *
 * Missing variables are reported by *name* so an operator can fix the
 * environment without any credential ever appearing in a log line.
 */
export function readMailConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedMailConfig {
  const missing: string[] = [];

  const host = requiredValue(env[MAIL_ENV_VARS.host]);
  if (host === null) missing.push(MAIL_ENV_VARS.host);

  const port = parsePort(env[MAIL_ENV_VARS.port]);
  if (port === null) missing.push(MAIL_ENV_VARS.port);

  const user = requiredValue(env[MAIL_ENV_VARS.user]);
  if (user === null) missing.push(MAIL_ENV_VARS.user);

  const password = requiredValue(env[MAIL_ENV_VARS.password]);
  if (password === null) missing.push(MAIL_ENV_VARS.password);

  const from = requiredValue(env[MAIL_ENV_VARS.from]);
  if (from === null) missing.push(MAIL_ENV_VARS.from);

  const resetUrl = parseResetUrl(env[MAIL_ENV_VARS.resetUrl]);
  if (resetUrl === null) missing.push(MAIL_ENV_VARS.resetUrl);

  const secure = parseSecure(env[MAIL_ENV_VARS.secure], port ?? 0);
  if (secure === null) missing.push(MAIL_ENV_VARS.secure);

  if (
    missing.length > 0 ||
    host === null ||
    port === null ||
    user === null ||
    password === null ||
    from === null ||
    resetUrl === null ||
    secure === null
  ) {
    return Object.freeze({
      configured: false as const,
      missing: Object.freeze(missing),
    });
  }

  const settings = {
    host,
    port,
    secure,
    user,
    from,
    resetUrl,
  } as MailSettings & { password: string };

  // Keep the SMTP password out of `JSON.stringify`, `Object.keys` and any
  // accidental structured log of the resolved configuration.
  Object.defineProperty(settings, 'password', {
    value: password,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return Object.freeze({
    configured: true as const,
    settings: Object.freeze(settings),
    missing: Object.freeze([]) as readonly [],
  });
}

function requiredValue(value: string | undefined): string | null {
  if (value === undefined || value.trim().length === 0) {
    return null;
  }

  return value.trim();
}

function parsePort(value: string | undefined): number | null {
  const raw = requiredValue(value);
  if (raw === null) {
    return null;
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }

  return port;
}

/**
 * `MAIL_SECURE` is optional; absent means "secure for port 465, STARTTLS
 * otherwise", which is the convention every SMTP provider documents.
 */
function parseSecure(value: string | undefined, port: number): boolean | null {
  const raw = requiredValue(value);
  if (raw === null) {
    return port === 465;
  }

  const normalised = raw.toLowerCase();
  if (normalised === 'true') return true;
  if (normalised === 'false') return false;

  return null;
}

function parseResetUrl(value: string | undefined): string | null {
  const raw = requiredValue(value);
  if (raw === null) {
    return null;
  }

  try {
    const url = new URL(raw);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.hostname.length === 0
    ) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}
