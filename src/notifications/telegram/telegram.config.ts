/**
 * Telegram settings read once at startup.
 *
 * The bot token is stored as a non-enumerable property so accidental
 * serialisation of the settings object (a debug log, an error dump) cannot print
 * it. Nothing in this module ever logs the token, the API URL, or the chat id.
 */

export const TELEGRAM_SETTINGS = 'TELEGRAM_SETTINGS' as const;

export interface TelegramSettings {
  /** Operator switch. Notifications are sent only when this is true. */
  enabled: boolean;
  /** True when the switch is on and both required values are present. */
  configured: boolean;
  botToken: string | null;
  chatId: string | null;
  /** Validated frontend base URL, used to build the admin dashboard link. */
  frontendUrl: string | null;
}

const readNonEmpty = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const readFrontendUrl = (value: string | undefined): string | null => {
  const raw = readNonEmpty(value);
  if (raw === null) return null;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return raw.replace(/\/+$/, '');
  } catch {
    return null;
  }
};

export const readTelegramSettings = (
  env: NodeJS.ProcessEnv = process.env,
): TelegramSettings => {
  const enabled =
    readNonEmpty(env.TELEGRAM_NOTIFICATIONS_ENABLED)?.toLowerCase() === 'true';
  const botToken = readNonEmpty(env.TELEGRAM_BOT_TOKEN);
  // Prefer the documented admin chat id; fall back to legacy name for compatibility.
  const chatId =
    readNonEmpty(env.TELEGRAM_ADMIN_CHAT_ID) ??
    readNonEmpty(env.TELEGRAM_CHAT_ID);
  const frontendUrl = readFrontendUrl(env.FRONTEND_URL);

  const settings: TelegramSettings = {
    enabled,
    configured: enabled && botToken !== null && chatId !== null,
    botToken,
    chatId,
    frontendUrl,
  };

  Object.defineProperty(settings, 'botToken', {
    value: botToken,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return Object.freeze(settings);
};

/** Builds the admin dashboard URL only for a valid configured base URL. */
export const buildAdminOrderUrl = (
  frontendUrl: string | null,
  orderId: string,
): string | null => {
  if (frontendUrl === null) return null;

  try {
    return new URL(`/admin/orders/${encodeURIComponent(orderId)}`, frontendUrl)
      .toString();
  } catch {
    return null;
  }
};
