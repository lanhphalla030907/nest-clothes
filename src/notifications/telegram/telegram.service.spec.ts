import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramDeliveryError, TelegramService } from './telegram.service.js';
import type { TelegramSettings } from './telegram.config.js';
import type { TelegramOrderAlertPayload } from './telegram-order-alert.message.js';

const payload: TelegramOrderAlertPayload = {
  orderId: 'order-1',
  orderNumber: 'ORD-1',
  customerName: 'Ada',
  itemCount: 1,
  subtotal: '10.00',
  shippingFee: '2.00',
  discount: '0.00',
  total: '12.00',
  currency: 'USD',
  paymentMethod: 'COD',
  paymentStatus: 'PENDING',
  orderDate: '2026-11-12T10:00:00.000Z',
  orderStatus: 'PENDING',
  items: [{ productName: 'Item', variantDetails: null, quantity: 1, unitPrice: '10.00' }],
};

const settings = (overrides: Partial<TelegramSettings> = {}): TelegramSettings =>
  ({
    enabled: true,
    configured: true,
    botToken: 'bot-token',
    chatId: 'chat-1',
    frontendUrl: null,
    ...overrides,
  }) as TelegramSettings;

describe('TelegramService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not send when notifications are disabled/unconfigured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new TelegramService(
      settings({ enabled: false, configured: false, botToken: null, chatId: null }),
    );
    await expect(service.sendOrderAlert(payload)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a successful Telegram notification', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new TelegramService(settings());

    await expect(service.sendOrderAlert(payload)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botbot-token/sendMessage');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as {
      chat_id: string;
      text: string;
      parse_mode: string;
    };
    expect(body.chat_id).toBe('chat-1');
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toContain('ORD-1');
  });

  it('throws a safe delivery error on Telegram API failure without leaking token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: vi.fn().mockResolvedValue({ ok: false, description: 'Bad Request' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new TelegramService(settings());

    await expect(service.sendOrderAlert(payload)).rejects.toThrow(
      TelegramDeliveryError,
    );
    await expect(service.sendOrderAlert(payload)).rejects.toThrow(
      /Telegram rejected the alert/,
    );
  });

  it('throws a safe delivery error on network timeout/failure', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new TelegramService(settings());

    await expect(service.sendOrderAlert(payload)).rejects.toThrow(
      'Telegram request timed out',
    );
  });
});
