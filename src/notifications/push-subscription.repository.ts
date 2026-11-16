import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Persistence for push subscriptions.
 *
 * All methods accept an optional transaction client so ownership transfer and
 * enqueue can run inside a short, well-scoped transaction.
 */
@Injectable()
export class PushSubscriptionRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    return client as Prisma.TransactionClient;
  }

  /**
   * Finds a subscription by endpoint and locks the row with `FOR UPDATE`.
   *
   * Used by the registration transfer path so that concurrent rebinds of the
   * same endpoint are serialized. Returns `null` when no row exists.
   */
  async findByEndpointForUpdate(
    endpoint: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const row = await this.client(client).$queryRawUnsafe<
      Array<{
        id: string;
        user_id: string;
        endpoint: string;
        is_active: boolean;
        revoked_at: Date | null;
      }>
    >(
      `SELECT id, user_id, endpoint, is_active, revoked_at
       FROM "push_subscriptions"
       WHERE "endpoint" = $1
       FOR UPDATE`,
      endpoint,
    );

    return row[0] ?? null;
  }

  /**
   * Creates a subscription bound to `userId`. Returns the stored row.
   */
  async create(
    data: Prisma.PushSubscriptionCreateInput,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    return this.client(client).pushSubscription.create({ data });
  }

  /**
   * Updates a subscription by id. Only the listed columns may change.
   */
  async updateById(
    id: string,
    data: Prisma.PushSubscriptionUpdateInput,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    return this.client(client).pushSubscription.update({
      where: { id },
      data,
    });
  }

  /**
   * Finds one active, non-revoked subscription owned by `userId` with `id`.
   */
  async findByIdAndUser(
    id: string,
    userId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    return this.client(client).pushSubscription.findFirst({
      where: { id, userId, isActive: true, revokedAt: null },
    });
  }

  /**
   * Returns every active, non-revoked subscription for `userId`. These are the
   * only subscriptions eligible for push delivery.
   */
  async findActiveByUser(
    userId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    return this.client(client).pushSubscription.findMany({
      where: { userId, isActive: true, revokedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        userAgent: true,
        isActive: true,
        createdAt: true,
      },
    });
  }

  /**
   * Soft-revokes a subscription owned by `userId`. Returns `true` when a row
   * was updated, `false` when it does not exist or is not owned by `userId`.
   */
  async revoke(
    id: string,
    userId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<boolean> {
    const result = await this.client(client).pushSubscription.updateMany({
      where: { id, userId, isActive: true, revokedAt: null },
      data: { isActive: false, revokedAt: new Date() },
    });
    return result.count > 0;
  }

  /**
   * Marks every non-terminal job for `subscriptionId` as terminal `FAILED`
   * with `OWNERSHIP_TRANSFERRED`, and clears all lease fields. Runs inside the
   * caller's transaction; no external I/O.
   */
  async markJobsOwnershipTransferred(
    subscriptionId: string,
    client: Prisma.TransactionClient,
  ): Promise<void> {
    await client.pushDeliveryJob.updateMany({
      where: {
        pushSubscriptionId: subscriptionId,
        status: { not: 'FAILED' },
      },
      data: {
        status: 'FAILED',
        lastErrorCode: 'OWNERSHIP_TRANSFERRED',
        lastErrorMessage:
          'Subscription ownership was transferred; this job can no longer be delivered.',
        lockedAt: null,
        lockedBy: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      },
    });
  }
}
