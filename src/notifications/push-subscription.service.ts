import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PushSubscriptionRepository } from './push-subscription.repository.js';
import { PushDeliveryRepository } from './push-delivery.repository.js';

/**
 * Push subscription lifecycle: register/rebind, list, and revoke.
 *
 * The endpoint is globally unique and authoritative. Rebinding an endpoint to a
 * different user is an ownership transfer that runs inside a single transaction
 * and terminalizes the prior owner's non-terminal delivery jobs.
 */
@Injectable()
export class PushSubscriptionService {
  private readonly logger = new Logger(PushSubscriptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptionRepository: PushSubscriptionRepository,
    private readonly deliveryRepository: PushDeliveryRepository,
  ) {}

  /**
   * Register or rebind a push subscription for the authenticated user.
   *
   * Exact sequence (§5 of the Phase 2 plan):
   * 1. Single transaction: `SELECT ... FOR UPDATE` the row by endpoint.
   * 2. No row: create bound to `userId`.
   * 3. Same owner: refresh keys/metadata, reactivate, clear revocation.
   * 4. Different owner (transfer): transfer ownership, reactivate, and in the
   *    same transaction terminalize all non-terminal jobs as
   *    `FAILED (OWNERSHIP_TRANSFERRED)` with cleared lease fields.
   *
   * Unique-conflict races are handled by retrying once: if two requests race
   * to create the same endpoint, the loser re-reads the now-existing row and
   * applies the same-same-owner or transfer path.
   */
  async registerSubscription(
    endpoint: string,
    p256dh: string,
    auth: string,
    userAgent: string | null | undefined,
    userId: string,
  ) {
    let attempt = 0;
    const maxAttempts = 2;

    while (attempt < maxAttempts) {
      attempt += 1;

      try {
        return await this.prisma.$transaction(async (tx) => {
          const existing = await this.subscriptionRepository.findByEndpointForUpdate(
            endpoint,
            tx,
          );

          const now = new Date();
          const updateData: Prisma.PushSubscriptionUpdateInput = {
            p256dh,
            auth,
            userAgent: userAgent ?? null,
            isActive: true,
            revokedAt: null,
            lastSeenAt: now,
            updatedAt: now,
          };

          if (existing === null) {
            // No row: create bound to the authenticated user.
            return this.subscriptionRepository.create(
              {
                endpoint,
                p256dh,
                auth,
                userAgent: userAgent ?? null,
                isActive: true,
                lastSeenAt: now,
                user: { connect: { id: userId } },
              },
              tx,
            );
          }

          if (existing.user_id === userId) {
            // Same owner: refresh keys/metadata, reactivate.
            return this.subscriptionRepository.updateById(
              existing.id,
              updateData,
              tx,
            );
          }

          // Transfer: different owner. Rebind and terminalize prior jobs.
          await this.subscriptionRepository.updateById(
            existing.id,
            { ...updateData, user: { connect: { id: userId } } },
            tx,
          );

          await this.subscriptionRepository.markJobsOwnershipTransferred(
            existing.id,
            tx,
          );

          return this.subscriptionRepository.findByIdAndUser(
            existing.id,
            userId,
            tx,
          );
        });
      } catch (error) {
        // Unique constraint on `endpoint`: a concurrent request created the
        // same endpoint first. Retry once so the re-read takes the
        // same-owner or transfer path instead of failing.
        const prismaError = error as Prisma.PrismaClientKnownRequestError;
        if (
          attempt < maxAttempts &&
          prismaError.code === 'P2002' &&
          Array.isArray(prismaError.meta?.target) &&
          prismaError.meta.target.includes('endpoint')
        ) {
          continue;
        }
        throw error;
      }
    }

    // Unreachable: the loop either returns or throws.
    throw new Error('Failed to register push subscription after retries');
  }

  /**
   * Returns safe metadata for every subscription owned by `userId`. The full
   * endpoint and key material are never returned.
   */
  async listSubscriptions(userId: string) {
    return this.subscriptionRepository.findActiveByUser(userId);
  }

  /**
   * Revokes (soft-deletes) a subscription owned by `userId`. Returns `true`
   * when a row was revoked, `false` when it does not exist or is not owned by
   * `userId`.
   */
  async revokeSubscription(
    subscriptionId: string,
    userId: string,
  ): Promise<boolean> {
    return this.subscriptionRepository.revoke(subscriptionId, userId);
  }
}
