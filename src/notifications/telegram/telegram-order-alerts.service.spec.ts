import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import { TelegramAlertStatus } from '../../generated/prisma/enums.js';
import { TelegramOrderAlertsService } from './telegram-order-alerts.service.js';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';

const buildSource = (overrides: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  orderNumber: 'ORD-20261112-ABC123',
  status: 'PENDING',
  subtotal: new Prisma.Decimal('40.00'),
  shippingFee: new Prisma.Decimal('5.00'),
  discountAmount: new Prisma.Decimal('3.00'),
  totalAmount: new Prisma.Decimal('42.00'),
  currency: 'USD',
  paymentMethod: 'COD',
  createdAt: new Date('2026-11-12T10:00:00.000Z'),
  user: { firstName: 'Ada', lastName: 'Lovelace' },
  items: [
    {
      productName: 'Wool Coat',
      variantOptionsSnapshot: [
        { optionName: 'Color', optionValue: 'Navy' },
        { optionName: 'Size', optionValue: 'M' },
      ],
      unitPrice: new Prisma.Decimal('25.00'),
      quantity: 1,
    },
  ],
  payments: [{ status: 'PENDING', createdAt: new Date('2026-11-12T10:00:00.000Z') }],
  ...overrides,
});

const buildAlert = (overrides: Record<string, unknown> = {}) => ({
  id: 'alert-1',
  orderId: ORDER_ID,
  payload: {
    orderId: ORDER_ID,
    orderNumber: 'ORD-20261112-ABC123',
    customerName: 'Ada Lovelace',
    itemCount: 1,
    subtotal: '40.00',
    shippingFee: '5.00',
    discount: '3.00',
    total: '42.00',
    currency: 'USD',
    paymentMethod: 'COD',
    paymentStatus: 'PENDING',
    orderDate: '2026-11-12T10:00:00.000Z',
    orderStatus: 'PENDING',
    items: [
      {
        productName: 'Wool Coat',
        variantDetails: 'Color: Navy, Size: M',
        quantity: 1,
        unitPrice: '25.00',
      },
    ],
  },
  status: TelegramAlertStatus.PENDING,
  attempts: 0,
  nextAttemptAt: new Date('2026-11-12T10:00:00.000Z'),
  lastError: null,
  sentAt: null,
  createdAt: new Date('2026-11-12T10:00:00.000Z'),
  updatedAt: new Date('2026-11-12T10:00:00.000Z'),
  ...overrides,
});

describe('TelegramOrderAlertsService', () => {
  let repository: {
    findOrderForTelegramAlert: ReturnType<typeof vi.fn>;
    createTelegramOrderAlert: ReturnType<typeof vi.fn>;
    findDueTelegramOrderAlerts: ReturnType<typeof vi.fn>;
    tryStartTelegramOrderAlert: ReturnType<typeof vi.fn>;
    markTelegramOrderAlertSent: ReturnType<typeof vi.fn>;
    markTelegramOrderAlertRetry: ReturnType<typeof vi.fn>;
    markTelegramOrderAlertFailed: ReturnType<typeof vi.fn>;
  };
  let telegramService: {
    isEnabled: boolean;
    sendOrderAlert: ReturnType<typeof vi.fn>;
  };
  let service: TelegramOrderAlertsService;

  beforeEach(() => {
    repository = {
      findOrderForTelegramAlert: vi.fn(),
      createTelegramOrderAlert: vi.fn(),
      findDueTelegramOrderAlerts: vi.fn().mockResolvedValue([]),
      tryStartTelegramOrderAlert: vi.fn().mockResolvedValue(true),
      markTelegramOrderAlertSent: vi.fn().mockResolvedValue(undefined),
      markTelegramOrderAlertRetry: vi.fn().mockResolvedValue(undefined),
      markTelegramOrderAlertFailed: vi.fn().mockResolvedValue(undefined),
    };
    telegramService = {
      isEnabled: true,
      sendOrderAlert: vi.fn().mockResolvedValue(undefined),
    };
    service = new TelegramOrderAlertsService(repository as never, telegramService as never);
    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.restoreAllMocks();
  });

  it('enqueues a new order alert from committed persisted order data', async () => {
    repository.findOrderForTelegramAlert.mockResolvedValue(buildSource());
    repository.createTelegramOrderAlert.mockResolvedValue(true);

    await service.enqueueNewOrderAlert(ORDER_ID);

    expect(repository.findOrderForTelegramAlert).toHaveBeenCalledWith(ORDER_ID);
    expect(repository.createTelegramOrderAlert).toHaveBeenCalledTimes(1);
    const [orderId, payload] = repository.createTelegramOrderAlert.mock.calls[0] as [string, any];
    expect(orderId).toBe(ORDER_ID);
    expect(payload.orderNumber).toBe('ORD-20261112-ABC123');
    expect(payload.customerName).toBe('Ada Lovelace');
    expect(payload.subtotal).toBe('40.00');
    expect(payload.shippingFee).toBe('5.00');
    expect(payload.discount).toBe('3.00');
    expect(payload.total).toBe('42.00');
    expect(payload.paymentMethod).toBe('COD');
    expect(payload.paymentStatus).toBe('PENDING');
    expect(payload.items).toEqual([
      {
        productName: 'Wool Coat',
        variantDetails: 'Color: Navy, Size: M',
        quantity: 1,
        unitPrice: '25.00',
      },
    ]);
  });

  it('prevents duplicate order alert outbox rows (dedupe)', async () => {
    repository.findOrderForTelegramAlert.mockResolvedValue(buildSource());
    repository.createTelegramOrderAlert.mockResolvedValue(false);
    const drainSpy = vi.spyOn(service, 'processDueAlerts');

    await service.enqueueNewOrderAlert(ORDER_ID);

    expect(repository.createTelegramOrderAlert).toHaveBeenCalledTimes(1);
    expect(drainSpy).not.toHaveBeenCalled();
  });

  it('does not enqueue when order lookup fails or order is missing', async () => {
    repository.findOrderForTelegramAlert.mockResolvedValue(null);

    await expect(service.enqueueNewOrderAlert(ORDER_ID)).resolves.toBeUndefined();

    expect(repository.createTelegramOrderAlert).not.toHaveBeenCalled();
  });

  it('swallows enqueue errors so checkout/order flow is never affected', async () => {
    repository.findOrderForTelegramAlert.mockRejectedValue(new Error('db unavailable'));

    await expect(service.enqueueNewOrderAlert(ORDER_ID)).resolves.toBeUndefined();
  });

  it('does not process pending alerts when Telegram is disabled/misconfigured', async () => {
    telegramService.isEnabled = false;
    repository.findDueTelegramOrderAlerts.mockResolvedValue([buildAlert()]);

    await service.processDueAlerts();

    expect(repository.findDueTelegramOrderAlerts).not.toHaveBeenCalled();
    expect(telegramService.sendOrderAlert).not.toHaveBeenCalled();
  });

  it('processes pending alerts and marks delivery success', async () => {
    repository.findDueTelegramOrderAlerts.mockResolvedValue([buildAlert()]);

    await service.processDueAlerts();

    expect(repository.tryStartTelegramOrderAlert).toHaveBeenCalledWith('alert-1', expect.any(Date));
    expect(telegramService.sendOrderAlert).toHaveBeenCalledTimes(1);
    expect(telegramService.sendOrderAlert.mock.calls[0][0]).toMatchObject({
      orderId: ORDER_ID,
      paymentMethod: 'COD',
      paymentStatus: 'PENDING',
      orderStatus: 'PENDING',
    });
    expect(repository.markTelegramOrderAlertSent).toHaveBeenCalledWith('alert-1', expect.any(Date));
    expect(repository.markTelegramOrderAlertRetry).not.toHaveBeenCalled();
  });

  it('schedules retry with backoff on Telegram delivery failure', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    telegramService.sendOrderAlert.mockRejectedValue(new Error('Telegram rejected the alert'));
    repository.findDueTelegramOrderAlerts.mockResolvedValue([buildAlert({ attempts: 0 })]);

    await service.processDueAlerts();

    expect(repository.markTelegramOrderAlertRetry).toHaveBeenCalledTimes(1);
    const [, attempts, nextAttemptAt, lastError] =
      repository.markTelegramOrderAlertRetry.mock.calls[0] as [string, number, Date, string];
    expect(attempts).toBe(1);
    expect(nextAttemptAt.getTime()).toBe(now + 30_000);
    expect(lastError).toContain('Telegram rejected the alert');
    expect(repository.markTelegramOrderAlertSent).not.toHaveBeenCalled();
    expect(repository.markTelegramOrderAlertFailed).not.toHaveBeenCalled();
  });

  it('marks alert as permanently failed after max attempts (no infinite retry)', async () => {
    telegramService.sendOrderAlert.mockRejectedValue(new Error('timeout'));
    repository.findDueTelegramOrderAlerts.mockResolvedValue([buildAlert({ attempts: 7 })]);

    await service.processDueAlerts();

    expect(repository.markTelegramOrderAlertFailed).toHaveBeenCalledWith(
      'alert-1',
      8,
      expect.stringContaining('timeout'),
    );
    expect(repository.markTelegramOrderAlertRetry).not.toHaveBeenCalled();
    expect(repository.markTelegramOrderAlertSent).not.toHaveBeenCalled();
  });

  it('allows multiple workers/instances to process safely by lease claim (no duplicate send)', async () => {
    repository.findDueTelegramOrderAlerts.mockResolvedValue([
      buildAlert({ id: 'alert-1' }),
      buildAlert({ id: 'alert-2' }),
    ]);
    repository.tryStartTelegramOrderAlert
      .mockResolvedValueOnce(false) // claimed by another worker
      .mockResolvedValueOnce(true);

    await service.processDueAlerts();

    expect(telegramService.sendOrderAlert).toHaveBeenCalledTimes(1);
    expect(repository.markTelegramOrderAlertSent).toHaveBeenCalledTimes(1);
    expect(repository.markTelegramOrderAlertSent).toHaveBeenCalledWith('alert-2', expect.any(Date));
  });

  it('skips concurrent processing within the same worker instance', async () => {
    let resolveDue: ((value: unknown[]) => void) | undefined;
    repository.findDueTelegramOrderAlerts.mockImplementation(
      () => new Promise((resolve) => { resolveDue = resolve; }),
    );

    const first = service.processDueAlerts();
    const second = service.processDueAlerts();
    resolveDue?.([]);
    await Promise.all([first, second]);

    expect(repository.findDueTelegramOrderAlerts).toHaveBeenCalledTimes(1);
  });

  it('does not process before worker start (module init)', async () => {
    const notStarted = new TelegramOrderAlertsService(repository as never, telegramService as never);
    repository.findDueTelegramOrderAlerts.mockResolvedValue([buildAlert()]);

    await notStarted.processDueAlerts();

    expect(repository.findDueTelegramOrderAlerts).not.toHaveBeenCalled();
  });
});
