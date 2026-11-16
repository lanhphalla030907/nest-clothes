import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PushSubscriptionRepository } from './push-subscription.repository.js';
import { PushDeliveryRepository } from './push-delivery.repository.js';
import { PushDeliveryStatus } from '../generated/prisma/enums.js';
import { validateNavigationRoute } from './push-navigation.js';

/**
 * Generic, non-sensitive push payload.
 *
 * Push bodies never contain order/customer data. Clients fetch protected
 * details via authenticated APIs. The `url` is a validated internal route.
 */
export const buildGenericPushPayload = (
  url: string | null | undefined,
): Prisma.InputJsonValue => {
  return {
    title: 'LOMOR',
    body: 'You have a new notification.',
    url: validateNavigationRoute(url),
  } satisfies Prisma.InputJsonValue;
};

/**
 * Enqueues push delivery jobs after a Notification is created.
 *
 * Called by `NotificationsService` after its transaction commits. Idempotent
 * on `(notificationId, pushSubscriptionId)`, so duplicate event handling
 * never creates duplicate jobs. Failures here must never break the original
 * business action or Phase 1 in-app notification behaviour — callers treat
 * enqueue as best-effort.
 */
@Injectable()
export class PushEnqueueService {
  private readonly logger = new Logger(PushEnqueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptionRepository: PushSubscriptionRepository,
    private readonly deliveryRepository: PushDeliveryRepository,
  ) {}

  /**
   * Creates exactly one PENDING job per active, non-revoked subscription
   * belonging to `userId`, for `notificationId`.
   *
   * Only subscriptions with `isActive = true`, `revokedAt IS NULL`, and
   * `subscription.userId === userId` are eligible. Jobs are created with
   * `skipDuplicates`, so a retry of the same enqueue is a no-op for existing
   * pairs.
   */
  async enqueueForNotification(
    notificationId: string,
    userId: string,
    url: string | null | undefined,
  ): Promise<void> {
    const payload = buildGenericPushPayload(url);

    const subscriptions =
      await this.subscriptionRepository.findActiveByUser(userId);

    if (subscriptions.length === 0) return;

    const jobs = subscriptions.map((sub: { id: string }) => ({
      notificationId,
      userId,
      pushSubscriptionId: sub.id,
      payload,
      status: PushDeliveryStatus.PENDING,
    }));

    try {
      await this.deliveryRepository.enqueueMany(jobs, this.prisma);
    } catch (error) {
      // Enqueue is best-effort: log and swallow so the original notification
      // creation is never affected by push delivery problems.
      this.logger.error(
        `Failed to enqueue push jobs for notification ${notificationId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  /**
   * Enqueues push jobs for all notifications of `userId` created after
   * `since` that do not yet have a push delivery job.
   *
   * Used after `createMany` (which does not return created ids) to cover all
   * newly created notifications for the affected users. Safe to repeat.
   */
  async enqueueForUserSince(
    userId: string,
    since: Date,
    url: string | null | undefined,
  ): Promise<void> {
    const payload = buildGenericPushPayload(url);

    const notifications = await this.prisma.notification.findMany({
      where: {
        userId,
        createdAt: { gte: since },
      },
      select: { id: true },
    });

    if (notifications.length === 0) return;

    const subscriptions =
      await this.subscriptionRepository.findActiveByUser(userId);

    if (subscriptions.length === 0) return;

    const jobs = notifications.flatMap((n) =>
      subscriptions.map((sub: { id: string }) => ({
        notificationId: n.id,
        userId,
        pushSubscriptionId: sub.id,
        payload,
        status: PushDeliveryStatus.PENDING,
      })),
    );

    try {
      await this.deliveryRepository.enqueueMany(jobs, this.prisma);
    } catch (error) {
      this.logger.error(
        `Failed to enqueue push jobs for user ${userId} since ${since.toISOString()}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}
