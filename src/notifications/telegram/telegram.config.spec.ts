import { describe, expect, it } from 'vitest';
import { buildAdminOrderUrl, readTelegramSettings } from './telegram.config.js';

describe('telegram config', () => {
  it('disables notifications by default when env vars are missing', () => {
    const settings = readTelegramSettings({});
    expect(settings.enabled).toBe(false);
    expect(settings.configured).toBe(false);
    expect(settings.chatId).toBeNull();
  });

  it('is not configured when enabled but bot token is missing', () => {
    const settings = readTelegramSettings({
      TELEGRAM_NOTIFICATIONS_ENABLED: 'true',
      TELEGRAM_ADMIN_CHAT_ID: '123',
    });
    expect(settings.enabled).toBe(true);
    expect(settings.configured).toBe(false);
  });

  it('is not configured when enabled but admin chat id is missing', () => {
    const settings = readTelegramSettings({
      TELEGRAM_NOTIFICATIONS_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: 'token',
    });
    expect(settings.enabled).toBe(true);
    expect(settings.configured).toBe(false);
  });

  it('accepts TELEGRAM_ADMIN_CHAT_ID and is configured when enabled with required values', () => {
    const settings = readTelegramSettings({
      TELEGRAM_NOTIFICATIONS_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_ADMIN_CHAT_ID: '456',
    });
    expect(settings.enabled).toBe(true);
    expect(settings.configured).toBe(true);
    expect(settings.chatId).toBe('456');
  });

  it('falls back to legacy TELEGRAM_CHAT_ID for compatibility', () => {
    const settings = readTelegramSettings({
      TELEGRAM_NOTIFICATIONS_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: 'token',
      TELEGRAM_CHAT_ID: 'legacy',
    });
    expect(settings.configured).toBe(true);
    expect(settings.chatId).toBe('legacy');
  });

  it('does not expose bot token as enumerable property', () => {
    const settings = readTelegramSettings({
      TELEGRAM_NOTIFICATIONS_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: 'secret-token',
      TELEGRAM_ADMIN_CHAT_ID: '456',
    });
    expect(Object.keys(settings)).not.toContain('botToken');
    expect(JSON.stringify(settings)).not.toContain('secret-token');
  });

  it('builds admin order URL only for valid frontend base URL', () => {
    expect(buildAdminOrderUrl('https://shop.example.com', 'order-1')).toBe(
      'https://shop.example.com/admin/orders/order-1',
    );
    expect(buildAdminOrderUrl(null, 'order-1')).toBeNull();
  });
});
