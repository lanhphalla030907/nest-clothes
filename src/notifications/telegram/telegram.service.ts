import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  buildAdminOrderUrl,
  readTelegramSettings,
  TELEGRAM_SETTINGS,
  type TelegramSettings,
} from './telegram.config.js';
import {
  renderTelegramOrderAlert,
  type TelegramOrderAlertPayload,
} from './telegram-order-alert.message.js';

/** A delivery failure whose message is safe to persist and log. */
export class TelegramDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramDeliveryError';
  }
}

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
}

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The only code that talks to the Telegram Bot API.
 *
 * Responsibilities stop at "render and send": retries, persistence and
 * idempotency belong to {@link TelegramOrderAlertsService}. The token is used to
 * build the request URL in memory and is never written to a log, an exception
 * message, or an API response.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly settings: TelegramSettings;

  constructor(
    @Inject(TELEGRAM_SETTINGS) settings: TelegramSettings = readTelegramSettings(),
  ) {
    this.settings = settings;

    if (settings.enabled && !settings.configured) {
      this.logger.warn(
        'Telegram notifications are enabled but TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID is missing; alerts are disabled',
      );
    }
  }

  get isEnabled(): boolean {
    return this.settings.configured;
  }

  /**
   * Sends one new-order alert.
   *
   * Throws {@link TelegramDeliveryError} when Telegram rejects the request or
   * cannot be reached; callers decide whether to retry. The message never
   * contains the bot token.
   */
  async sendOrderAlert(payload: TelegramOrderAlertPayload): Promise<void> {
    if (!this.settings.configured) return;

    const text = renderTelegramOrderAlert(
      payload,
      buildAdminOrderUrl(this.settings.frontendUrl, payload.orderId),
    );

    await this.sendMessage(text);
  }

  private async sendMessage(text: string): Promise<void> {
    const token = this.settings.botToken;
    const chatId = this.settings.chatId;
    if (token === null || chatId === null) return;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
          signal: controller.signal,
        },
      );

      let body: TelegramApiResponse | null = null;
      try {
        body = (await response.json()) as TelegramApiResponse;
      } catch {
        body = null;
      }

      if (!response.ok || body?.ok !== true) {
        const description =
          body?.description?.slice(0, 200) ?? `HTTP ${response.status}`;
        throw new TelegramDeliveryError(
          `Telegram rejected the alert: ${description}`,
        );
      }
    } catch (error) {
      if (error instanceof TelegramDeliveryError) throw error;
      // Deliberately no request URL: it contains the bot token.
      throw new TelegramDeliveryError(
        error instanceof Error && error.name === 'AbortError'
          ? 'Telegram request timed out'
          : 'Telegram is unreachable',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
