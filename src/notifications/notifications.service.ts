import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { NotificationType } from '../generated/prisma/enums.js';
import {
  availableStock,
  stockStatusFor,
  type StockStatus,
} from '../common/utils/available-stock.js';
import { NOTIFICATION_NOT_FOUND } from './constants/notification.constants.js';
import type { ListNotificationsQueryDto } from './dto/list-notifications-query.dto.js';
import {
  NotificationListResponseDto,
  toNotificationView,
  type NotificationListResponse,
  type NotificationView,
} from './dto/notification-response.dto.js';
import {
  NotificationsRepository,
  type NotificationRow,
  type OrderNotificationSummary,
} from './notifications.repository.js';

/** The audience a notification's navigation route is written for. */
type NotificationAudience = 'ADMIN' | 'CUSTOMER';

/** The `data` payload persisted on every notification this service creates. */
interface NotificationNavigationData {
  entityType: 'ORDER' | 'VARIANT';
  entityId: string;
  route: string;
  orderNumber?: string;
}

/**
 * In-app notification reads and the event handlers that create notifications.
 *
 * ## Two responsibilities, one class
 *
 * The **read side** is the customer/admin notification center: a caller lists,
 * counts, marks read and deletes *their own* notifications. Every query is scoped
 * to the identity resolved from the verified access token, so "not yours" and
 * "does not exist" are the same 404 and neither is probeable.
 *
 * The **event side** is a set of fire-and-forget handlers that other features call
 * *after* their own transaction has committed. They deliberately never throw: a
 * notification is a courtesy, and it must never be the reason an order, a payment
 * or a stock movement fails. Each handler catches and logs its own errors, so a
 * caller can safely write `void notifications.notifyOrderShipped(orderId)`.
 *
 * ## Idempotency
 *
 * Every created row carries a `dedupeKey` unique to *(audience, recipient, event,
 * entity)*. A webhook redelivery, a retried request or a double-clicked action
 * therefore collapses onto the same row rather than producing a second
 * notification. The keys include the recipient id because a single event fans out
 * to several administrators, and each of them must receive exactly one copy.
 *
 * ## No business rules live here
 *
 * The handlers do not decide whether an event *happened* — the feature that owns
 * the transition does, and calls the matching handler only when it committed. This
 * class turns an already-decided fact into rows. That is what keeps payment,
 * inventory and delivery policy in exactly one place each.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly repository: NotificationsRepository) {}

  // ---------------------------------------------------------------------------
  // Read API (scoped to the authenticated caller)
  // ---------------------------------------------------------------------------

  /** One page of the caller's notifications, newest first. */
  async list(
    userId: string,
    query: ListNotificationsQueryDto,
  ): Promise<NotificationListResponse> {
    const { rows, total } = await this.repository.findPage(
      userId,
      query.page,
      query.limit,
    );

    return NotificationListResponseDto.fromRows(
      rows,
      query.page,
      query.limit,
      total,
    );
  }

  /** How many of the caller's notifications are still unread. */
  async unreadCount(userId: string): Promise<{ count: number }> {
    return { count: await this.repository.countUnread(userId) };
  }

  /**
   * Marks one of the caller's notifications read and returns it.
   *
   * Idempotent: marking an already-read notification is a no-op that still returns
   * the row. A missing notification, or one owned by somebody else, is a 404.
   */
  async markRead(userId: string, id: string): Promise<NotificationView> {
    const existing = await this.requireOwn(userId, id);

    if (existing.readAt !== null) {
      return toNotificationView(existing);
    }

    const readAt = new Date();
    await this.repository.markRead(userId, id, readAt);

    return toNotificationView({ ...existing, readAt });
  }

  /** Marks every unread notification of the caller as read. */
  async markAllRead(userId: string): Promise<{ updated: number }> {
    return { updated: await this.repository.markAllRead(userId, new Date()) };
  }

  /** Deletes one of the caller's notifications, or 404. */
  async remove(userId: string, id: string): Promise<void> {
    const deleted = await this.repository.deleteByIdForUser(userId, id);

    if (!deleted) {
      throw new NotFoundException(NOTIFICATION_NOT_FOUND);
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers (fire-and-forget; never throw)
  // ---------------------------------------------------------------------------

  /**
   * ADMIN — a new order was placed.
   *
   * Called by checkout after the order transaction commits. One notification per
   * active administrator.
   */
  notifyNewOrder(orderId: string): Promise<void> {
    return this.safe('new-order notification', async () => {
      const order = await this.repository.findOrderSummary(orderId);
      if (order === null) return this.warnMissingOrder(orderId);

      const adminIds = await this.repository.findActiveAdminIds();
      if (adminIds.length === 0) return;

      const customerName = this.customerName(order);

      await this.repository.createMany(
        adminIds.map((adminId) => ({
          userId: adminId,
          type: NotificationType.ADMIN_NEW_ORDER,
          title: 'New order received',
          message: `Order ${order.orderNumber} was placed by ${customerName} for ${this.money(order.totalAmount)} ${order.currency}.`,
          data: this.navigationData(order, 'ADMIN'),
          dedupeKey: `admin:${adminId}:new-order:${orderId}`,
        })),
      );
    });
  }

  /**
   * ADMIN + CUSTOMER — a verified online payment was recorded.
   *
   * Called after the payment transaction commits. Only a payment the provider
   * independently confirmed reaches here, so a failed or pending attempt never
   * produces a notification.
   */
  notifyPaymentSuccess(orderId: string): Promise<void> {
    return this.safe('payment-success notification', async () => {
      const order = await this.repository.findOrderSummary(orderId);
      if (order === null) return this.warnMissingOrder(orderId);

      const rows: Prisma.NotificationCreateManyInput[] = [
        {
          userId: order.userId,
          type: NotificationType.PAYMENT_CONFIRMED,
          title: 'Payment successful',
          message: `We received your payment for order ${order.orderNumber}.`,
          data: this.navigationData(order, 'CUSTOMER'),
          dedupeKey: `customer:${order.userId}:payment:${orderId}`,
        },
      ];

      for (const adminId of await this.repository.findActiveAdminIds()) {
        rows.push({
          userId: adminId,
          type: NotificationType.ADMIN_PAYMENT_SUCCESS,
          title: 'Payment received',
          message: `Order ${order.orderNumber} has been paid (${this.money(order.totalAmount)} ${order.currency}).`,
          data: this.navigationData(order, 'ADMIN'),
          dedupeKey: `admin:${adminId}:payment:${orderId}`,
        });
      }

      await this.repository.createMany(rows);
    });
  }

  /**
   * CUSTOMER — the order moved from `PENDING` to `CONFIRMED`.
   *
   * Called after the transition commits, whether the confirmation came from a
   * verified online payment or from an administrator confirming a COD order.
   */
  notifyOrderConfirmed(orderId: string): Promise<void> {
    return this.customerOrderNotification(
      'order-confirmed notification',
      orderId,
      NotificationType.ORDER_CONFIRMED,
      'Order confirmed',
      (order) => `Your order ${order.orderNumber} is confirmed and being prepared.`,
      'order-confirmed',
    );
  }

  /** CUSTOMER — the order was shipped. Called after the ship transition commits. */
  notifyOrderShipped(orderId: string): Promise<void> {
    return this.customerOrderNotification(
      'order-shipped notification',
      orderId,
      NotificationType.ORDER_SHIPPED,
      'Order shipped',
      (order) => `Order ${order.orderNumber} is on its way.`,
      'order-shipped',
    );
  }

  /** CUSTOMER — the parcel went out for delivery. */
  notifyOutForDelivery(orderId: string): Promise<void> {
    return this.customerOrderNotification(
      'out-for-delivery notification',
      orderId,
      NotificationType.ORDER_OUT_FOR_DELIVERY,
      'Out for delivery',
      (order) => `Order ${order.orderNumber} is out for delivery today.`,
      'out-for-delivery',
    );
  }

  /** CUSTOMER — the order was delivered. */
  notifyOrderDelivered(orderId: string): Promise<void> {
    return this.customerOrderNotification(
      'order-delivered notification',
      orderId,
      NotificationType.ORDER_DELIVERED,
      'Order delivered',
      (order) => `Order ${order.orderNumber} has been delivered.`,
      'order-delivered',
    );
  }

  /**
   * ADMIN + CUSTOMER — the order was cancelled.
   *
   * Called after the cancellation transaction commits, on both the customer and
   * the administrator cancellation paths.
   */
  notifyOrderCancelled(orderId: string): Promise<void> {
    return this.safe('order-cancelled notification', async () => {
      const order = await this.repository.findOrderSummary(orderId);
      if (order === null) return this.warnMissingOrder(orderId);

      const rows: Prisma.NotificationCreateManyInput[] = [
        {
          userId: order.userId,
          type: NotificationType.ORDER_CANCELLED,
          title: 'Order cancelled',
          message: `Order ${order.orderNumber} was cancelled.`,
          data: this.navigationData(order, 'CUSTOMER'),
          dedupeKey: `customer:${order.userId}:order-cancelled:${orderId}`,
        },
      ];

      for (const adminId of await this.repository.findActiveAdminIds()) {
        rows.push({
          userId: adminId,
          type: NotificationType.ADMIN_ORDER_CANCELLED,
          title: 'Order cancelled',
          message: `Order ${order.orderNumber} was cancelled.`,
          data: this.navigationData(order, 'ADMIN'),
          dedupeKey: `admin:${adminId}:order-cancelled:${orderId}`,
        });
      }

      await this.repository.createMany(rows);
    });
  }

  /**
   * ADMIN — a variant's stock crossed into `LOW_STOCK` or `OUT_OF_STOCK`.
   *
   * `previous` and `next` are the statuses the inventory transaction computed
   * before and after its write. Only a genuine transition *into* a low or out
   * state is reported: a write that leaves the status unchanged is ignored, so
   * editing an already-low variant does not re-alert. The committed row is
   * re-read and the status re-derived before anything is written, and the dedupe
   * key is bucketed by UTC day so a variant that oscillates cannot spam the
   * operator.
   */
  notifyStockTransition(
    variantId: string,
    previous: StockStatus,
    next: StockStatus,
  ): Promise<void> {
    if (next === previous) return Promise.resolve();
    if (next !== 'LOW_STOCK' && next !== 'OUT_OF_STOCK') {
      return Promise.resolve();
    }

    return this.safe('stock notification', async () => {
      const summary = await this.repository.findVariantStockSummary(variantId);
      if (summary === null) return;

      const currentStatus = stockStatusFor(availableStock(summary));
      if (currentStatus !== 'LOW_STOCK' && currentStatus !== 'OUT_OF_STOCK') {
        return;
      }

      const adminIds = await this.repository.findActiveAdminIds();
      if (adminIds.length === 0) return;

      const available = availableStock(summary);
      const isOut = currentStatus === 'OUT_OF_STOCK';
      const type = isOut
        ? NotificationType.ADMIN_OUT_OF_STOCK
        : NotificationType.ADMIN_LOW_STOCK;
      const title = isOut ? 'Out of stock' : 'Low stock';
      const message = isOut
        ? `${summary.productName} (${summary.sku}) is out of stock.`
        : `${summary.productName} (${summary.sku}) is low on stock: ${available} left.`;
      const state = isOut ? 'out-of-stock' : 'low-stock';
      const day = utcDayBucket(new Date());

      await this.repository.createMany(
        adminIds.map((adminId) => ({
          userId: adminId,
          type,
          title,
          message,
          data: {
            entityType: 'VARIANT',
            entityId: variantId,
            route: '/admin/product-variants',
          } satisfies NotificationNavigationData as Prisma.InputJsonValue,
          dedupeKey: `admin:${adminId}:${state}:${variantId}:${day}`,
        })),
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Shared body of the four single-customer order notifications. */
  private customerOrderNotification(
    label: string,
    orderId: string,
    type: NotificationType,
    title: string,
    message: (order: OrderNotificationSummary) => string,
    dedupeEvent: string,
  ): Promise<void> {
    return this.safe(label, async () => {
      const order = await this.repository.findOrderSummary(orderId);
      if (order === null) return this.warnMissingOrder(orderId);

      await this.repository.createMany([
        {
          userId: order.userId,
          type,
          title,
          message: message(order),
          data: this.navigationData(order, 'CUSTOMER'),
          dedupeKey: `customer:${order.userId}:${dedupeEvent}:${orderId}`,
        },
      ]);
    });
  }

  /** Loads a notification the caller owns, or throws the shared 404. */
  private async requireOwn(
    userId: string,
    id: string,
  ): Promise<NotificationRow> {
    const notification = await this.repository.findByIdForUser(userId, id);

    if (notification === null) {
      throw new NotFoundException(NOTIFICATION_NOT_FOUND);
    }

    return notification;
  }

  /**
   * Runs a handler body and swallows any failure into a log line.
   *
   * This is what makes every `notify*` method safe to call as fire-and-forget
   * after a transaction commits: an unavailable notification table must not turn
   * a successful order into a failed response.
   */
  private async safe(
    label: string,
    work: () => Promise<void>,
  ): Promise<void> {
    try {
      await work();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Failed to create ${label}: ${message}`);
    }
  }

  private warnMissingOrder(orderId: string): void {
    this.logger.warn(
      `Skipped notification: order ${orderId} not found in committed state`,
    );
  }

  private customerName(order: OrderNotificationSummary): string {
    const name = `${order.user.firstName ?? ''} ${order.user.lastName ?? ''}`.trim();
    return name.length > 0 ? name : 'a customer';
  }

  private money(value: Prisma.Decimal): string {
    return value.toFixed(2);
  }

  /** The `data` payload that lets the client navigate to the related entity. */
  private navigationData(
    order: OrderNotificationSummary,
    audience: NotificationAudience,
  ): Prisma.InputJsonValue {
    const data: NotificationNavigationData = {
      entityType: 'ORDER',
      entityId: order.id,
      orderNumber: order.orderNumber,
      route:
        audience === 'ADMIN'
          ? `/admin/orders/${order.id}`
          : `/account/orders/${order.id}`,
    };

    return data as unknown as Prisma.InputJsonValue;
  }
}

/** `YYYY-MM-DD` in UTC, used to bucket at most one stock alert per variant per day. */
function utcDayBucket(date: Date): string {
  return date.toISOString().slice(0, 10);
}
