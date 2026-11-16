import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PushDeliveryStatus } from '../generated/prisma/enums.js';

/**
 * Persistence for push delivery jobs.
 *
 * Enqueue is idempotent on `(notificationId, pushSubscriptionId)` via the
 * database unique constraint, so retrying enqueue after a duplicate event
 * never creates duplicate jobs.
 */

export interface ClaimedJob {
  id: string;
  notificationId: string | null;
  userId: string;
  pushSubscriptionId: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  leaseExpiresAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  payload: unknown;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  subscriptionId: string;
  subscriptionUserId: string;
  subscriptionIsActive: boolean;
  subscriptionRevokedAt: Date | null;
  subscriptionEndpoint: string;
  subscriptionP256dh: string;
  subscriptionAuth: string;
  notificationUserId: string | null;
}

@Injectable()
export class PushDeliveryRepository {
  private readonly logger = new Logger(PushDeliveryRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  private client(
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    return client as Prisma.TransactionClient;
  }

  /**
   * Creates delivery jobs for one notification across multiple subscriptions,
   * skipping any job that already exists for the same (notification,
   * subscription) pair.
   *
   * Safe to repeat: duplicate enqueue attempts are collapsed by
   * `skipDuplicates` onto the existing row.
   */
  async enqueueMany(
    jobs: Array<{
      notificationId: string;
      userId: string;
      pushSubscriptionId: string;
      payload: Prisma.InputJsonValue;
    }>,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<number> {
    if (jobs.length === 0) return 0;

    const result = await this.client(client).pushDeliveryJob.createMany({
      data: jobs.map((job) => ({
        notificationId: job.notificationId,
        userId: job.userId,
        pushSubscriptionId: job.pushSubscriptionId,
        status: PushDeliveryStatus.PENDING,
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: new Date(),
        payload: job.payload,
      })),
      skipDuplicates: true,
    });
    return result.count;
  }

  /**
   * Claims a batch of due PENDING jobs atomically using
   * `SELECT ... FOR UPDATE SKIP LOCKED`.
   *
   * Claiming sets PROCESSING + lease fields and commits immediately. It does
   * NOT increment `attempts` — that happens later in the step-2 critical
   * section.
   *
   * Returns the claimed rows with their full related subscription/notification
   * data so the worker can validate ownership without another round trip.
   */
  async claimJobs(
    batchSize: number,
    workerId: string,
    leaseTtlSeconds: number,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<ClaimedJob[]> {
    const leaseExpiresAt = new Date(Date.now() + leaseTtlSeconds * 1000);
    const now = new Date();

    const raw = await this.client(client).$queryRawUnsafe<
      Array<Record<string, unknown>>
    >(
      `
WITH due_jobs AS (
  SELECT j.id
  FROM "push_delivery_jobs" j
  WHERE j.status = $1
    AND j."nextAttemptAt" <= $2
    AND j.attempts < j."maxAttempts"
  ORDER BY j."nextAttemptAt" ASC, j."createdAt" ASC, j.id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $3
)
UPDATE "push_delivery_jobs" j
SET status = $4,
    "lockedAt" = $5,
    "lockedBy" = $6,
    "leaseExpiresAt" = $7,
    "updatedAt" = $8
FROM due_jobs d
WHERE j.id = d.id
RETURNING
  j.id,
  j."notificationId",
  j."userId",
  j."pushSubscriptionId",
  j.status,
  j.attempts,
  j."maxAttempts",
  j."nextAttemptAt",
  j."lockedAt",
  j."lockedBy",
  j."leaseExpiresAt",
  j."lastErrorCode",
  j."lastErrorMessage",
  j.payload,
  j."sentAt",
  j."createdAt",
  j."updatedAt",
  s.id AS subscription_id,
  s."userId" AS subscription_user_id,
  s."isActive" AS subscription_is_active,
  s."revokedAt" AS subscription_revoked_at,
  s."endpoint" AS subscription_endpoint,
  s."p256dh" AS subscription_p256dh,
  s."auth" AS subscription_auth,
  n."userId" AS notification_user_id
`,
      PushDeliveryStatus.PENDING,
      now,
      batchSize,
      PushDeliveryStatus.PROCESSING,
      now,
      workerId,
      leaseExpiresAt,
      now,
    );

    // The RETURNING from the UPDATE doesn't include the JOIN data we need.
    // Re-query the claimed jobs with their related data.
    const ids = raw.map((r) => r.id as string);
    if (ids.length === 0) return [];

    const jobs = await this.client(client).pushDeliveryJob.findMany({
      where: { id: { in: ids } },
      include: {
        subscription: true,
        notification: { select: { userId: true } },
      },
    });

    return jobs.map((j) => ({
      id: j.id,
      notificationId: j.notificationId,
      userId: j.userId,
      pushSubscriptionId: j.pushSubscriptionId,
      status: j.status,
      attempts: j.attempts,
      maxAttempts: j.maxAttempts,
      nextAttemptAt: j.nextAttemptAt,
      lockedAt: j.lockedAt,
      lockedBy: j.lockedBy,
      leaseExpiresAt: j.leaseExpiresAt,
      lastErrorCode: j.lastErrorCode,
      lastErrorMessage: j.lastErrorMessage,
      payload: j.payload,
      sentAt: j.sentAt,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      subscriptionId: j.subscription.id,
      subscriptionUserId: j.subscription.userId,
      subscriptionIsActive: j.subscription.isActive,
      subscriptionRevokedAt: j.subscription.revokedAt,
      subscriptionEndpoint: j.subscription.endpoint,
      subscriptionP256dh: j.subscription.p256dh,
      subscriptionAuth: j.subscription.auth,
      notificationUserId: j.notification?.userId ?? null,
    }));
  }

  /**
   * Reserves one attempt for a claimed job inside the step-2 critical section.
   *
   * Called after `FOR UPDATE` on `PushSubscription` and after all validations
   * pass. This is the ONLY place in the system where `attempts` is incremented.
   *
   * Returns true when the increment was committed, false when the job is no
   * longer PROCESSING (another worker or the sweeper won the fence).
   */
  async reserveAttempt(
    jobId: string,
    workerId: string,
    client: Prisma.TransactionClient,
  ): Promise<boolean> {
    const result = await client.pushDeliveryJob.updateMany({
      where: {
        id: jobId,
        status: PushDeliveryStatus.PROCESSING,
        lockedBy: workerId,
      },
      data: {
        attempts: { increment: 1 },
        updatedAt: new Date(),
      },
    });
    return result.count > 0;
  }

  /**
   * Fenced finalization of a job out of PROCESSING.
   *
   * The WHERE clause matches job id, PROCESSING status, this worker's lease,
   * and a lease that has not yet expired. If zero rows are updated, the caller
   * must discard its result — another worker, a transfer, or the sweeper won
   * the fence.
   *
   * Returns true when the finalization was applied.
   */
  async finalizeJob(
    jobId: string,
    workerId: string,
    updates: Prisma.PushDeliveryJobUpdateInput,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<boolean> {
    const result = await this.client(client).pushDeliveryJob.updateMany({
      where: {
        id: jobId,
        status: PushDeliveryStatus.PROCESSING,
        lockedBy: workerId,
        leaseExpiresAt: { gt: new Date() },
      },
      data: updates,
    });
    return result.count > 0;
  }

  /**
   * Deactivates a subscription after a 410/404 from the push service.
   *
   * Sets isActive=false and revokedAt=now(). Runs in a short transaction with
   * no external I/O.
   */
  async deactivateSubscription(
    subscriptionId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    await this.client(client).pushSubscription.update({
      where: { id: subscriptionId },
      data: { isActive: false, revokedAt: new Date() },
    });
  }

  /**
   * Recovers expired leases for PROCESSING jobs.
   *
   * Jobs at maxAttempts are terminalized FAILED; all others return to PENDING
   * with nextAttemptAt = now(). Attempts are never incremented by the sweeper.
   *
   * Also finalizes any PENDING job with attempts >= maxAttempts as FAILED.
   *
   * Uses raw SQL for the attempts >= maxAttempts comparison because Prisma's
   * type-safe filter operators don't accept column-to-column comparisons.
   *
   * The fenced WHERE conditions prevent overwriting a concurrent worker's
   * valid reservation or finalization.
   */
  async sweepExpiredLeases(
    workerId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<{ recovered: number; failed: number }> {
    const now = new Date();

    // Expired leases below maxAttempts -> PENDING, no attempts change.
    const recovered = await this.client(client).$executeRawUnsafe(
      `UPDATE "push_delivery_jobs"
       SET status = $1,
           "nextAttemptAt" = $2,
           "lockedAt" = NULL,
           "lockedBy" = NULL,
           "leaseExpiresAt" = NULL,
           "updatedAt" = $3
       WHERE status = $4
         AND locked_by IS DISTINCT FROM $5
         AND "leaseExpiresAt" < $6
         AND attempts < "maxAttempts"`,
      PushDeliveryStatus.PENDING,
      now,
      now,
      PushDeliveryStatus.PROCESSING,
      workerId,
      now,
    );

    // Expired leases at maxAttempts -> FAILED.
    const failedAtMax = await this.client(client).$executeRawUnsafe(
      `UPDATE "push_delivery_jobs"
       SET status = $1,
           last_error_code = $2,
           last_error_message = $3,
           "lockedAt" = NULL,
           "lockedBy" = NULL,
           "leaseExpiresAt" = NULL,
           "updatedAt" = $4
       WHERE status = $5
         AND locked_by IS DISTINCT FROM $6
         AND "leaseExpiresAt" < $7
         AND attempts >= "maxAttempts"`,
      PushDeliveryStatus.FAILED,
      'MAX_ATTEMPTS',
      'Maximum delivery attempts reached; job terminalized by lease sweeper.',
      now,
      PushDeliveryStatus.PROCESSING,
      workerId,
      now,
    );

    // Safety net: PENDING jobs that are already exhausted.
    const failedPending = await this.client(client).$executeRawUnsafe(
      `UPDATE "push_delivery_jobs"
       SET status = $1,
           last_error_code = $2,
           last_error_message = $3,
           "updatedAt" = $4
       WHERE status = $5
         AND attempts >= "maxAttempts"`,
      PushDeliveryStatus.FAILED,
      'MAX_ATTEMPTS',
      'Maximum delivery attempts reached; job terminalized by safety net.',
      now,
      PushDeliveryStatus.PENDING,
    );

    return {
      recovered: Number(recovered),
      failed: Number(failedAtMax) + Number(failedPending),
    };
  }

  /**
   * Fenced finalization wrapper. Delegates to `finalizeJob` which applies
   * the fence (status=PROCESSING, lockedBy=workerId, lease not expired).
   */
  async finalizeFenced(
    jobId: string,
    workerId: string,
    updates: Prisma.PushDeliveryJobUpdateInput,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<boolean> {
    return this.finalizeJob(jobId, workerId, updates, client);
  }

  /**
   * Finds a subscription by id and locks the row with `SELECT ... FOR UPDATE`.
   *
   * Used by the worker's step-2 critical section to serialize with ownership
   * transfer. Returns the full subscription row (or null if missing).
   */
  async findSubscriptionByIdForUpdate(
    id: string,
    client: Prisma.TransactionClient,
  ): Promise<{
    id: string;
    userId: string;
    isActive: boolean;
    revokedAt: Date | null;
    endpoint: string;
    p256dh: string;
    auth: string;
  } | null> {
    const rows = await client.$queryRawUnsafe<
      Array<{
        id: string;
        user_id: string;
        is_active: boolean;
        revoked_at: Date | null;
        endpoint: string;
        p256dh: string;
        auth: string;
      }>
    >(
      `SELECT id, user_id, is_active, revoked_at, endpoint, p256dh, auth
       FROM "push_subscriptions"
       WHERE id = $1
       FOR UPDATE`,
      id,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      isActive: row.is_active,
      revokedAt: row.revoked_at,
      endpoint: row.endpoint,
      p256dh: row.p256dh,
      auth: row.auth,
    };
  }
}
