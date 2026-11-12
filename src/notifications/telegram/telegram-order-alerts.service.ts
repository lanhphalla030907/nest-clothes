import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Prisma } from '../../generated/prisma/client.js';
import { TelegramAlertStatus } from '../../generated/prisma/enums.js';
import { NotificationsRepository } from '../notifications.repository.js';
import { TelegramService } from './telegram.service.js';
import type {
  TelegramOrderAlertItemPayload,
  TelegramOrderAlertPayload,
} from './telegram-order-alert.message.js';

const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;

const formatMoney = (value: Prisma.Decimal): string => value.toFixed(2);

const formatVariantDetails = (snapshot: unknown): string | null => {
  if (!Array.isArray(snapshot)) return null;
  const parts = snapshot
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const rec = entry as { optionName?: unknown; optionValue?: unknown };
      const optionName = typeof rec.optionName === 'string' ? rec.optionName : '';
      const optionValue = typeof rec.optionValue === 'string' ? rec.optionValue : '';
      if (!optionName && !optionValue) return null;
      return optionName && optionValue ? optionName + ': ' + optionValue : optionValue || optionName;
    })
    .filter((value): value is string => Boolean(value && value.trim()));
  return parts.length > 0 ? parts.join(', ') : null;
};

const derivePaymentStatus = (order: {
  paymentMethod: string | null;
  status: string;
  payments: Array<{ status: string; createdAt: Date }>;
}): string => {
  if (order.payments.length > 0) {
    const latest = [...order.payments].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    )[0];
    if (latest?.status) return latest.status;
  }
  if (order.paymentMethod === 'COD') {
    return ['DELIVERED', 'COMPLETED'].includes(order.status) ? 'PAID' : 'PENDING';
  }
  return 'PENDING';
};

@Injectable()
export class TelegramOrderAlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramOrderAlertsService.name);
  private processing = false;
  private started = false;

  constructor(
    private readonly repository: NotificationsRepository,
    private readonly telegramService: TelegramService,
  ) {}

  onModuleInit(): void {
    this.started = true;
  }

  onModuleDestroy(): void {
    this.started = false;
  }

  async enqueueNewOrderAlert(orderId: string): Promise<void> {
    try {
      const source = await this.repository.findOrderForTelegramAlert(orderId);
      if (!source) {
        this.logger.warn(
          'Skipped Telegram order alert: order ' + orderId + ' not found in committed state',
        );
        return;
      }

      const payload = this.buildPayload(source);
      const created = await this.repository.createTelegramOrderAlert(orderId, payload);
      if (created && this.telegramService.isEnabled) {
        void this.processDueAlerts();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(
        'Failed to enqueue Telegram order alert for order ' + orderId + ': ' + message,
      );
    }
  }

  @Interval(30_000)
  async processDueAlerts(): Promise<void> {
    if (!this.started || this.processing) return;
    if (!this.telegramService.isEnabled) return;

    this.processing = true;
    try {
      const due = await this.repository.findDueTelegramOrderAlerts(new Date(), 20);
      for (const alert of due) {
        if (alert.status !== TelegramAlertStatus.PENDING) continue;

        const leased = await this.repository.tryStartTelegramOrderAlert(alert.id, new Date());
        if (!leased) continue;

        const payload = this.normalizePayload(alert.payload);
        if (!payload) {
          await this.repository.markTelegramOrderAlertFailed(
            alert.id,
            alert.attempts + 1,
            'Invalid alert payload',
          );
          continue;
        }

        try {
          await this.telegramService.sendOrderAlert(payload);
          await this.repository.markTelegramOrderAlertSent(alert.id, new Date());
        } catch (error) {
          const attempts = alert.attempts + 1;
          const message = error instanceof Error ? error.message : 'Telegram delivery failed';
          if (attempts >= MAX_ATTEMPTS) {
            await this.repository.markTelegramOrderAlertFailed(alert.id, attempts, message);
          } else {
            const delay = Math.min(
              MAX_BACKOFF_MS,
              BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1),
            );
            await this.repository.markTelegramOrderAlertRetry(
              alert.id,
              attempts,
              new Date(Date.now() + delay),
              message,
            );
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error('Telegram order alert worker failed: ' + message);
    } finally {
      this.processing = false;
    }
  }

  private buildPayload(source: {
    id: string;
    orderNumber: string;
    status: string;
    subtotal: Prisma.Decimal;
    shippingFee: Prisma.Decimal;
    discountAmount: Prisma.Decimal;
    totalAmount: Prisma.Decimal;
    currency: string;
    paymentMethod: string | null;
    createdAt: Date;
    user: { firstName: string; lastName: string };
    items: Array<{
      productName: string;
      variantOptionsSnapshot: unknown;
      unitPrice: Prisma.Decimal;
      quantity: number;
    }>;
    payments: Array<{ status: string; createdAt: Date }>;
  }): TelegramOrderAlertPayload {
    const customerName =
      ((source.user.firstName ?? '') + ' ' + (source.user.lastName ?? '')).trim() ||
      'Customer';
    const items: TelegramOrderAlertItemPayload[] = source.items.map((item) => ({
      productName: item.productName,
      variantDetails: formatVariantDetails(item.variantOptionsSnapshot),
      quantity: item.quantity,
      unitPrice: formatMoney(item.unitPrice),
    }));

    return {
      orderId: source.id,
      orderNumber: source.orderNumber,
      customerName,
      itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
      subtotal: formatMoney(source.subtotal),
      shippingFee: formatMoney(source.shippingFee),
      discount: formatMoney(source.discountAmount),
      total: formatMoney(source.totalAmount),
      currency: source.currency,
      paymentMethod: source.paymentMethod,
      paymentStatus: derivePaymentStatus(source),
      orderDate: source.createdAt.toISOString(),
      orderStatus: source.status,
      items,
    };
  }

  private normalizePayload(payload: unknown): TelegramOrderAlertPayload | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Partial<TelegramOrderAlertPayload> & { items?: unknown };
    if (
      typeof p.orderId !== 'string' ||
      typeof p.orderNumber !== 'string' ||
      typeof p.customerName !== 'string' ||
      typeof p.orderStatus !== 'string' ||
      typeof p.currency !== 'string'
    ) {
      return null;
    }

    const items = Array.isArray(p.items)
      ? p.items
          .map((item) => {
            if (!item || typeof item !== 'object') return null;
            const i = item as Partial<TelegramOrderAlertItemPayload>;
            if (
              typeof i.productName !== 'string' ||
              typeof i.quantity !== 'number' ||
              typeof i.unitPrice !== 'string'
            ) {
              return null;
            }
            return {
              productName: i.productName,
              variantDetails: typeof i.variantDetails === 'string' ? i.variantDetails : null,
              quantity: i.quantity,
              unitPrice: i.unitPrice,
            } as TelegramOrderAlertItemPayload;
          })
          .filter((item): item is TelegramOrderAlertItemPayload => item !== null)
      : [];

    return {
      orderId: p.orderId,
      orderNumber: p.orderNumber,
      customerName: p.customerName,
      itemCount:
        typeof p.itemCount === 'number'
          ? p.itemCount
          : items.reduce((sum, item) => sum + item.quantity, 0),
      subtotal: typeof p.subtotal === 'string' ? p.subtotal : '0.00',
      shippingFee: typeof p.shippingFee === 'string' ? p.shippingFee : '0.00',
      discount: typeof p.discount === 'string' ? p.discount : '0.00',
      total: typeof p.total === 'string' ? p.total : '0.00',
      currency: p.currency,
      paymentMethod:
        typeof p.paymentMethod === 'string' || p.paymentMethod === null ? p.paymentMethod : null,
      paymentStatus:
        typeof p.paymentStatus === 'string' || p.paymentStatus === null ? p.paymentStatus : null,
      orderDate: typeof p.orderDate === 'string' ? p.orderDate : new Date().toISOString(),
      orderStatus: p.orderStatus,
      items,
    };
  }
}
