import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PushDeliveryStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VAPID_SETTINGS, getVapidPrivateKey } from './vapid/vapid.config.js';
import type { VapidSettings } from './vapid/vapid.config.js';
import { PushDeliveryRepository, type ClaimedJob } from './push-delivery.repository.js';
import {
  readPushWorkerConfig,
  type PushWorkerConfig,
} from './push-worker.config.js';

/** Error codes persisted on terminal jobs. Sanitized — no secrets, no URLs. */
export const JobErrorCode = {
  SUBSCRIPTION_MISSING: 'SUBSCRIPTION_MISSING',
  SUBSCRIPTION_INACTIVE: 'SUBSCRIPTION_INACTIVE',
  SUBSCRIPTION_REVOKED: 'SUBSCRIPTION_REVOKED',
  OWNERSHIP_MISMATCH: 'OWNERSHIP_MISMATCH',
  NOTIFICATION_MISSING: 'NOTIFICATION_MISSING',
  OWNERSHIP_TRANSFERRED: 'OWNERSHIP_TRANSFERRED',
  MAX_ATTEMPTS: 'MAX_ATTEMPTS',
  WEB_PUSH_RETRYABLE: 'WEB_PUSH_RETRYABLE',
  WEB_PUSH_NON_RETRYABLE: 'WEB_PUSH_NON_RETRYABLE',
  WEB_PUSH_GONE: 'WEB_PUSH_GONE',
  WEB_PUSH_NOT_FOUND: 'WEB_PUSH_NOT_FOUND',
  WEB_PUSH_TIMEOUT: 'WEB_PUSH_TIMEOUT',
  WEB_PUSH_UNKNOWN: 'WEB_PUSH_UNKNOWN',
} as const;

type JobErrorCode = (typeof JobErrorCode)[keyof typeof JobErrorCode];

/** Classification of a web-push delivery outcome. */
type DeliveryOutcome =
  | { kind: 'sent' }
  | { kind: 'retryable'; errorCode: JobErrorCode; message: string }
  | { kind: 'nonRetryable'; errorCode: JobErrorCode; message: string }
  | { kind: 'gone'; errorCode: JobErrorCode; message: string }
  | { kind: 'notFound'; errorCode: JobErrorCode; message: string }
  | { kind: 'timeout'; errorCode: JobErrorCode; message: string };

const MAX_ATTEMPTS = 5;

/**
 * Web Push delivery worker.
 *
 * Claims due `PushDeliveryJob` rows with `SELECT ... FOR UPDATE SKIP LOCKED`,
 * reserves one send attempt in a short critical section, revalidates ownership
 * immediately before the network call, sends via `web-push`, and finalizes
 * under a fence that discards stale results from transfers or sweeps.
 *
 * All database work happens in short transactions; the external HTTP call
 * never holds a transaction or row lock.
 */
@Injectable()
export class PushDeliveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushDeliveryWorker.name);
  private readonly workerId: string;
  private processing = false;
  private started = false;
  private pollTimer?: ReturnType<typeof setInterval>;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(VAPID_SETTINGS) private readonly vapidSettings: VapidSettings,
    private readonly prisma: PrismaService,
    private readonly deliveryRepository: PushDeliveryRepository,
    @Inject('PUSH_WORKER_CONFIG') config: PushWorkerConfig = readPushWorkerConfig(),
  ) {
    this.workerId = `push-worker-${crypto.randomUUID()}`;
    this.config = config;
  }

  private readonly config: PushWorkerConfig;

  /** Whether push is configured and the worker should run. */
  get isEnabled(): boolean {
    return this.started && this.vapidSettings.configured;
  }

  onModuleInit(): void {
    this.started = true;
    if (!this.vapidSettings.configured) {
      this.logger.log(
        'Push worker disabled: VAPID settings not configured (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT)',
      );
      return;
    }
    this.pollTimer = setInterval(
      () => void this.runCycle(),
      this.config.pollIntervalMs,
    );
    this.sweepTimer = setInterval(
      () => void this.runSweep(),
      this.config.leaseSweepIntervalMs,
    );
    this.logger.log(
      `Push worker started (leaseTtl=${this.config.leaseTtlSeconds}s, poll=${this.config.pollIntervalMs}ms, sweep=${this.config.leaseSweepIntervalMs}ms, batch=${this.config.batchSize})`,
    );
  }

  onModuleDestroy(): void {
    this.started = false;
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer);
  }

  /**
   * Poll loop entrypoint. Claims a batch of due jobs and processes each one
   * through the full claim → reserve → revalidate → send → finalize pipeline.
   *
   * Guarded by `processing` so overlapping ticks never run concurrently.
   * Also callable directly from tests.
   */
  async runCycle(): Promise<void> {
    if (!this.isEnabled || this.processing) return;

    this.processing = true;
    try {
      const jobs = await this.deliveryRepository.claimJobs(
        this.config.batchSize,
        this.workerId,
        this.config.leaseTtlSeconds,
      );

      for (const job of jobs) {
        try {
          await this.processJob(job);
        } catch {
          this.logger.error(
            `Failed to process push job ${job.id}: worker cycle error`,
          );
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Push worker cycle failed: ${message}`);
    } finally {
      this.processing = false;
    }
  }

  /**
   * Process one claimed job through the complete pipeline.
   *
   * Steps:
   *  1. Critical section: lock subscription, validate, reserve attempt.
   *  2. Pre-send revalidation: verify state is still valid.
   *  3. Send via web-push (outside DB).
   *  4. Fenced finalization.
   */
  private async processJob(job: ClaimedJob): Promise<void> {
    // ---- Step 2: critical section (short tx, subscription lock) ----
    const reserved = await this.prisma.$transaction(async (tx) => {
      // Lock the subscription row with SELECT ... FOR UPDATE so that
      // ownership transfer (which uses the same lock on the same row) is
      // serialized with this reservation.
      const subscription = await this.deliveryRepository.findSubscriptionByIdForUpdate(
        job.pushSubscriptionId,
        tx,
      );

      if (subscription === null) {
        // Missing subscription → terminal FAILED.
        await this.finalizeFenced(
          tx,
          job.id,
          {
            status: PushDeliveryStatus.FAILED,
            lastErrorCode: JobErrorCode.SUBSCRIPTION_MISSING,
            lastErrorMessage: 'Push subscription no longer exists.',
            lockedAt: null,
            lockedBy: null,
            leaseExpiresAt: null,
            updatedAt: new Date(),
          },
        );
        return false;
      }

      if (!subscription.isActive || subscription.revokedAt !== null) {
        const code = subscription.revokedAt !== null
          ? JobErrorCode.SUBSCRIPTION_REVOKED
          : JobErrorCode.SUBSCRIPTION_INACTIVE;
        await this.finalizeFenced(
          tx,
          job.id,
          {
            status: PushDeliveryStatus.FAILED,
            lastErrorCode: code,
            lastErrorMessage:
              code === JobErrorCode.SUBSCRIPTION_REVOKED
                ? 'Push subscription is revoked.'
                : 'Push subscription is inactive.',
            lockedAt: null,
            lockedBy: null,
            leaseExpiresAt: null,
            updatedAt: new Date(),
          },
        );
        return false;
      }

      // Ownership: subscription.userId must equal job.userId and
      // notification.userId (if the notification still exists).
      if (
        subscription.userId !== job.userId ||
        (job.notificationUserId !== null &&
          job.notificationUserId !== job.userId)
      ) {
        await this.finalizeFenced(
          tx,
          job.id,
          {
            status: PushDeliveryStatus.FAILED,
            lastErrorCode: JobErrorCode.OWNERSHIP_MISMATCH,
            lastErrorMessage:
              'Subscription owner does not match the job or notification owner.',
            lockedAt: null,
            lockedBy: null,
            leaseExpiresAt: null,
            updatedAt: new Date(),
          },
        );
        return false;
      }

      // Defensive: claim predicate should prevent this, but guard anyway.
      if (job.attempts >= job.maxAttempts) {
        await this.finalizeFenced(
          tx,
          job.id,
          {
            status: PushDeliveryStatus.FAILED,
            lastErrorCode: JobErrorCode.MAX_ATTEMPTS,
            lastErrorMessage: 'Maximum delivery attempts already reached.',
            lockedAt: null,
            lockedBy: null,
            leaseExpiresAt: null,
            updatedAt: new Date(),
          },
        );
        return false;
      }

      // Reserve exactly one attempt. This is the only increment in the system.
      const incremented = await this.deliveryRepository.reserveAttempt(
        job.id,
        this.workerId,
        tx,
      );
      if (!incremented) {
        // Fence lost — another worker or the sweeper took the job.
        return false;
      }

      return true;
    });

    if (!reserved) return;

    // ---- Step 3: pre-send revalidation (short tx / consistent snapshot) ----
    const stillValid = await this.prisma.$transaction(async (tx) => {
      const currentJob = await tx.pushDeliveryJob.findUnique({
        where: { id: job.id },
        select: {
          id: true,
          status: true,
          lockedBy: true,
          leaseExpiresAt: true,
          attempts: true,
          userId: true,
        },
      });
      if (currentJob === null) return false;
      if (currentJob.status !== PushDeliveryStatus.PROCESSING) return false;
      if (currentJob.lockedBy !== this.workerId) return false;
      if (
        currentJob.leaseExpiresAt === null ||
        currentJob.leaseExpiresAt.getTime() <= Date.now()
      ) {
        return false;
      }
      if (currentJob.attempts !== job.attempts + 1) return false;
      if (currentJob.userId !== job.userId) return false;

      const currentSub = await tx.pushSubscription.findUnique({
        where: { id: job.pushSubscriptionId },
        select: {
          id: true,
          userId: true,
          isActive: true,
          revokedAt: true,
        },
      });
      if (currentSub === null) return false;
      if (!currentSub.isActive || currentSub.revokedAt !== null) return false;
      if (currentSub.userId !== job.userId) return false;

      if (job.notificationUserId !== null) {
        const currentNotification = await tx.notification.findUnique({
          where: { id: job.notificationId! },
          select: { userId: true },
        });
        if (currentNotification === null) return false;
        if (currentNotification.userId !== job.userId) return false;
      }

      return true;
    });

    if (!stillValid) {
      // Do not send. If we still hold the lease, terminalize under fence;
      // otherwise discard — the transfer/sweeper owns the result now.
      await this.deliveryRepository.finalizeFenced(
        job.id,
        this.workerId,
        {
          status: PushDeliveryStatus.FAILED,
          lastErrorCode: JobErrorCode.OWNERSHIP_TRANSFERRED,
          lastErrorMessage:
            'Ownership or subscription state changed before delivery; job terminalized.',
          lockedAt: null,
          lockedBy: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        },
      );
      return;
    }

    // ---- Step 4: network call (outside any DB transaction or row lock) ----
    const subRow = await this.prisma.pushSubscription.findUnique({
      where: { id: job.pushSubscriptionId },
      select: { endpoint: true, p256dh: true, auth: true },
    });
    if (subRow === null) {
      await this.finalizeFencedDirect(
        job.id,
        {
          status: PushDeliveryStatus.FAILED,
          lastErrorCode: JobErrorCode.SUBSCRIPTION_MISSING,
          lastErrorMessage: 'Push subscription no longer exists.',
          lockedAt: null,
          lockedBy: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        },
      );
      return;
    }

    const outcome = await this.sendPush(
      {
        endpoint: subRow.endpoint,
        keys: { p256dh: subRow.p256dh, auth: subRow.auth },
      },
      job.payload,
    );

    // ---- Step 5: fenced finalization ----
    const now = new Date();
    switch (outcome.kind) {
      case 'sent': {
        await this.finalizeFencedDirect(job.id, {
          status: PushDeliveryStatus.SENT,
          sentAt: now,
          lockedAt: null,
          lockedBy: null,
          leaseExpiresAt: null,
          updatedAt: now,
        });
        break;
      }
      case 'gone':
      case 'notFound': {
        // 410 / 404: deactivate the subscription and terminalize the job.
        await this.prisma.$transaction(async (tx) => {
          await this.deliveryRepository.deactivateSubscription(
            job.pushSubscriptionId,
            tx,
          );
          await this.finalizeFenced(
            tx,
            job.id,
            {
              status: PushDeliveryStatus.FAILED,
              lastErrorCode: outcome.errorCode,
              lastErrorMessage: outcome.message,
              lockedAt: null,
              lockedBy: null,
              leaseExpiresAt: null,
              updatedAt: now,
            },
          );
        });
        break;
      }
      case 'retryable':
      case 'timeout': {
        const attempts = job.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          await this.finalizeFencedDirect(job.id, {
            status: PushDeliveryStatus.FAILED,
            lastErrorCode: JobErrorCode.MAX_ATTEMPTS,
            lastErrorMessage: outcome.message,
            lockedAt: null,
            lockedBy: null,
            leaseExpiresAt: null,
            updatedAt: now,
          });
        } else {
          const backoffSeconds =
            this.config.retryBackoffSeconds[attempts - 1] ??
            this.config.retryBackoffSeconds[
              this.config.retryBackoffSeconds.length - 1
            ];
          await this.finalizeFencedDirect(job.id, {
            status: PushDeliveryStatus.PENDING,
            nextAttemptAt: new Date(Date.now() + backoffSeconds * 1000),
            lastErrorCode: outcome.errorCode,
            lastErrorMessage: outcome.message,
            lockedAt: null,
            lockedBy: null,
            leaseExpiresAt: null,
            updatedAt: now,
          });
        }
        break;
      }
      case 'nonRetryable': {
        await this.finalizeFencedDirect(job.id, {
          status: PushDeliveryStatus.FAILED,
          lastErrorCode: outcome.errorCode,
          lastErrorMessage: outcome.message,
          lockedAt: null,
          lockedBy: null,
          leaseExpiresAt: null,
          updatedAt: now,
        });
        break;
      }
    }
  }

  /**
   * Fenced update inside an existing transaction. If zero rows match, the
   * result is discarded (another worker won the fence).
   */
  private async finalizeFenced(
    tx: Prisma.TransactionClient,
    jobId: string,
    updates: Prisma.PushDeliveryJobUpdateInput,
  ): Promise<boolean> {
    return this.deliveryRepository.finalizeJob(
      jobId,
      this.workerId,
      updates,
      tx,
    );
  }

  /**
   * Fenced update using a fresh transaction (outside the critical section).
   */
  private async finalizeFencedDirect(
    jobId: string,
    updates: Prisma.PushDeliveryJobUpdateInput,
  ): Promise<boolean> {
    return this.deliveryRepository.finalizeJob(
      jobId,
      this.workerId,
      updates,
    );
  }

  /**
   * Send one push notification via `web-push`.
   *
   * Classifies the outcome so the caller can decide retry vs terminal.
   * Never logs the VAPID private key or subscription endpoint.
   */
  private async sendPush(
    subscription: {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    },
    payload: unknown,
  ): Promise<DeliveryOutcome> {
    const webPush = await import('web-push');

    const vapidDetails = {
      subject: this.vapidSettings.subject ?? '',
      publicKey: this.vapidSettings.publicKey ?? '',
      privateKey: getVapidPrivateKey(this.vapidSettings) ?? '',
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
      await webPush.sendNotification(
        subscription,
        body,
        {
          vapidDetails,
          TTL: 86400,
          contentEncoding: 'aes128gcm',
        },
        controller.signal,
      );
      return { kind: 'sent' };
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;

      if (status === 410) {
        return { kind: 'gone', errorCode: JobErrorCode.WEB_PUSH_GONE, message: 'Subscription endpoint is gone (410).' };
      }
      if (status === 404) {
        return {
          kind: 'notFound',
          errorCode: JobErrorCode.WEB_PUSH_NOT_FOUND,
          message: 'Subscription endpoint not found (404).',
        };
      }
      if (status === 400 || status === 403) {
        return {
          kind: 'nonRetryable',
          errorCode: JobErrorCode.WEB_PUSH_NON_RETRYABLE,
          message: `Push service rejected the request (HTTP ${status}).`,
        };
      }
      if (status === 429 || (status !== undefined && status >= 500)) {
        return {
          kind: 'retryable',
          errorCode: JobErrorCode.WEB_PUSH_RETRYABLE,
          message: `Push service temporarily unavailable (HTTP ${status}).`,
        };
      }
      // AbortError, network errors, unknown status → retryable by default.
      return {
        kind: 'timeout',
        errorCode: JobErrorCode.WEB_PUSH_TIMEOUT,
        message: 'Push request timed out or network error.',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Lease recovery sweeper entrypoint. Runs on its own interval.
   *
   * Expired PROCESSING leases below maxAttempts → PENDING (nextAttemptAt=now(),
   * attempts unchanged). At maxAttempts → FAILED. Also finalizes PENDING jobs
   * already at maxAttempts.
   *
   * Fenced so a concurrent worker's valid reservation is never overwritten.
   * Also callable directly from tests.
   */
  async runSweep(): Promise<void> {
    if (!this.isEnabled) return;

    try {
      const result = await this.deliveryRepository.sweepExpiredLeases(
        this.workerId,
      );
      if (result.recovered > 0 || result.failed > 0) {
        this.logger.log(
          `Lease sweep recovered ${result.recovered}, failed ${result.failed}`,
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Lease sweep failed: ${message}`);
    }
  }
}
