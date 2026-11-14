import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { TelegramAlertStatus } from '../generated/prisma/enums.js';
import type { Notification } from '../generated/prisma/client.js';
import { Role } from '../generated/prisma/enums.js';
import { ACTIVE_USER_STATUS } from '../common/constants/user-status.constants.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { TelegramOrderAlertPayload } from './telegram/telegram-order-alert.message.js';

/** Columns returned to callers; dedupe_key never leaves this layer. */
const NOTIFICATION_SELECT = {
  id: true,
  userId: true,
  type: true,
  title: true,
  message: true,
  data: true,
  readAt: true,
  createdAt: true,
} satisfies Prisma.NotificationSelect;

export type NotificationRow = Omit<Notification, 'dedupeKey'>;

/** The narrow order projection the notification handlers need. */
export interface OrderNotificationSummary {
  id: string;
  orderNumber: string;
  userId: string;
  status: string;
  subtotal: Prisma.Decimal;
  shippingFee: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
  currency: string;
  paymentMethod: string | null;
  createdAt: Date;
  user: { firstName: string; lastName: string };
  items: Array<{ quantity: number }>;
}

/** The narrow feedback projection used for the admin alert. */
export interface FeedbackNotificationSummary {
  id: string;
  customerId: string;
  title: string;
  message: string;
  customer: { firstName: string; lastName: string };
}

/**
 * The narrow stock projection the low/out-of-stock handlers need.
 *
 * Only the counters and the labels an administrator recognises the variant by are
 * read. The available amount is deliberately absent: it is derived by the caller
 * through `availableStock`, so this layer never owns a second definition of it.
 */
export interface VariantStockSummary {
  variantId: string;
  sku: string;
  productName: string;
  quantity: number;
  reservedQuantity: number;
}

export interface TelegramOrderAlertRow {
  id: string;
  orderId: string;
  payload: unknown;
  status: TelegramAlertStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TelegramOrderAlertSource {
  id: string;
  orderNumber: string;
  userId: string;
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
}

const ALERT_SELECT = {
  id: true,
  orderId: true,
  payload: true,
  status: true,
  attempts: true,
  nextAttemptAt: true,
  lastError: true,
  sentAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TelegramOrderAlertSelect;

/**
 * Persistence for in-app notifications plus Telegram order-alert outbox reads/writes.
 */
@Injectable()
export class NotificationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Inserts notifications, skipping rows whose dedupeKey already exists.
   */
  async createMany(
    data: Prisma.NotificationCreateManyInput[],
  ): Promise<number> {
    if (data.length === 0) return 0;

    const result = await this.prisma.notification.createMany({
      data,
      skipDuplicates: true,
    });
    return result.count;
  }

  async findPage(
    userId: string,
    page: number,
    limit: number,
  ): Promise<{ rows: NotificationRow[]; total: number }> {
    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: NOTIFICATION_SELECT,
      }),
      this.prisma.notification.count({ where: { userId } }),
    ]);

    return { rows: rows as NotificationRow[], total };
  }

  countUnread(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { userId, readAt: null },
    });
  }

  findByIdForUser(
    userId: string,
    id: string,
  ): Promise<NotificationRow | null> {
    return this.prisma.notification.findFirst({
      where: { id, userId },
      select: NOTIFICATION_SELECT,
    }) as Promise<NotificationRow | null>;
  }

  async markRead(userId: string, id: string, readAt: Date): Promise<boolean> {
    const result = await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt },
    });
    return result.count > 0;
  }

  markAllRead(userId: string, readAt: Date): Promise<number> {
    return this.prisma.notification
      .updateMany({
        where: { userId, readAt: null },
        data: { readAt },
      })
      .then((result) => result.count);
  }

  /**
   * Deletes one of the caller's notifications.
   *
   * `deleteMany` rather than `delete` on purpose: the `where` clause carries the
   * ownership predicate, so a row that exists but belongs to somebody else matches
   * nothing and is reported as `false` — the caller turns that into the same 404
   * as an absent row, and a cross-account delete is unrepresentable.
   */
  async deleteByIdForUser(userId: string, id: string): Promise<boolean> {
    const result = await this.prisma.notification.deleteMany({
      where: { id, userId },
    });
    return result.count > 0;
  }

  findOrderSummary(orderId: string): Promise<OrderNotificationSummary | null> {
    return this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        userId: true,
        status: true,
        subtotal: true,
        shippingFee: true,
        discountAmount: true,
        totalAmount: true,
        currency: true,
        paymentMethod: true,
        createdAt: true,
        user: { select: { firstName: true, lastName: true } },
        items: { select: { quantity: true } },
      },
    });
  }

  findFeedbackSummary(
    feedbackId: string,
  ): Promise<FeedbackNotificationSummary | null> {
    return this.prisma.feedback.findUnique({
      where: { id: feedbackId },
      select: {
        id: true,
        customerId: true,
        title: true,
        message: true,
        customer: { select: { firstName: true, lastName: true } },
      },
    });
  }

  /**
   * Loads the committed stock row for a variant, joined to the labels a stock
   * alert renders.
   *
   * The stock handlers run *after* the inventory transaction commits and re-read
   * the row here rather than trusting the counters they were handed, so a
   * notification always describes persisted state. `null` means the variant has no
   * inventory row (or no longer exists), which the caller treats as "nothing to
   * alert about" rather than inventing a row.
   */
  async findVariantStockSummary(
    variantId: string,
  ): Promise<VariantStockSummary | null> {
    const row = await this.prisma.inventory.findUnique({
      where: { variantId },
      select: {
        variantId: true,
        quantity: true,
        reservedQuantity: true,
        variant: {
          select: { sku: true, product: { select: { name: true } } },
        },
      },
    });

    if (row === null) return null;

    return {
      variantId: row.variantId,
      sku: row.variant.sku,
      productName: row.variant.product.name,
      quantity: row.quantity,
      reservedQuantity: row.reservedQuantity,
    };
  }

  /** Active administrators are the audience for operational notifications. */
  async findActiveAdminIds(): Promise<string[]> {
    const admins = await this.prisma.user.findMany({
      where: { role: Role.ADMIN, status: ACTIVE_USER_STATUS },
      select: { id: true },
    });
    return admins.map((admin) => admin.id);
  }

  /**
   * Loads the persisted order data needed for a new-order Telegram alert.
   * Uses committed DB state only (items snapshot, customer, payments) and never
   * trusts request payloads.
   */
  findOrderForTelegramAlert(
    orderId: string,
  ): Promise<TelegramOrderAlertSource | null> {
    return this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        userId: true,
        status: true,
        subtotal: true,
        shippingFee: true,
        discountAmount: true,
        totalAmount: true,
        currency: true,
        paymentMethod: true,
        createdAt: true,
        user: { select: { firstName: true, lastName: true } },
        items: {
          select: {
            productName: true,
            variantOptionsSnapshot: true,
            unitPrice: true,
            quantity: true,
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
        payments: {
          select: { status: true, createdAt: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 5,
        },
      },
    });
  }

  async createTelegramOrderAlert(
    orderId: string,
    payload: TelegramOrderAlertPayload,
  ): Promise<boolean> {
    const result = await this.prisma.telegramOrderAlert.createMany({
      data: [
        {
          orderId,
          payload: payload as unknown as Prisma.InputJsonValue,
          status: TelegramAlertStatus.PENDING,
          nextAttemptAt: new Date(),
        },
      ],
      skipDuplicates: true,
    });
    return result.count > 0;
  }

  findDueTelegramOrderAlerts(
    now: Date,
    limit = 20,
  ): Promise<TelegramOrderAlertRow[]> {
    return this.prisma.telegramOrderAlert.findMany({
      where: {
        status: TelegramAlertStatus.PENDING,
        nextAttemptAt: { lte: now },
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
      select: ALERT_SELECT,
    }) as Promise<TelegramOrderAlertRow[]>;
  }

  async claimTelegramOrderAlert(id: string, now: Date): Promise<boolean> {
    const result = await this.prisma.telegramOrderAlert.updateMany({
      where: {
        id,
        status: TelegramAlertStatus.PENDING,
        nextAttemptAt: { lte: now },
      },
      data: {
        status: TelegramAlertStatus.PENDING,
      },
    });
    // claim by touching updatedAt via optimistic condition in processing flow:
    // actual claim is done by mark attempt+lease in service using transaction-like updateMany
    return result.count === 1;
  }

  async tryStartTelegramOrderAlert(id: string, now: Date): Promise<boolean> {
    const result = await this.prisma.telegramOrderAlert.updateMany({
      where: {
        id,
        status: TelegramAlertStatus.PENDING,
        nextAttemptAt: { lte: now },
      },
      data: {
        nextAttemptAt: new Date(now.getTime() + 60_000),
      },
    });
    return result.count === 1;
  }

  async markTelegramOrderAlertSent(id: string, sentAt: Date): Promise<void> {
    await this.prisma.telegramOrderAlert.updateMany({
      where: { id },
      data: {
        status: TelegramAlertStatus.SENT,
        sentAt,
        lastError: null,
      },
    });
  }

  async markTelegramOrderAlertRetry(
    id: string,
    attempts: number,
    nextAttemptAt: Date,
    lastError: string,
  ): Promise<void> {
    await this.prisma.telegramOrderAlert.updateMany({
      where: { id },
      data: {
        status: TelegramAlertStatus.PENDING,
        attempts,
        nextAttemptAt,
        lastError: lastError.slice(0, 500),
      },
    });
  }

  async markTelegramOrderAlertFailed(
    id: string,
    attempts: number,
    lastError: string,
  ): Promise<void> {
    await this.prisma.telegramOrderAlert.updateMany({
      where: { id },
      data: {
        status: TelegramAlertStatus.FAILED,
        attempts,
        nextAttemptAt: new Date(),
        lastError: lastError.slice(0, 500),
      },
    });
  }
}
