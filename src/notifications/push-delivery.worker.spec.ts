import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { PushDeliveryRepository } from './push-delivery.repository.js';
import { PushDeliveryWorker } from './push-delivery.worker.js';
import { readVapidSettings } from './vapid/vapid.config.js';

vi.mock('web-push', () => ({
  generateVAPIDKeys: () => ({
    publicKey: 'BFnKiyoDJJ985Z9L1E--9fTKabH_FVK6Rr2yUIfmGmZ-mPQyE6ytyyXEDt78CB4_L2OQoev_wJJWe8jg8PXBVTY',
    privateKey: '0bz-Yaf9uz4meUqzD6NEudH2-YJUWP7nvuloxil_FhA',
  }),
  sendNotification: vi.fn().mockResolvedValue(undefined),
}));

const vapidKeys = { publicKey: 'BFnKiyoDJJ985Z9L1E--9fTKabH_FVK6Rr2yUIfmGmZ-mPQyE6ytyyXEDt78CB4_L2OQoev_wJJWe8jg8PXBVTY', privateKey: '0bz-Yaf9uz4meUqzD6NEudH2-YJUWP7nvuloxil_FhA' };

const VAPID_ENV = {
  VAPID_PUBLIC_KEY: vapidKeys.publicKey,
  VAPID_PRIVATE_KEY: vapidKeys.privateKey,
  VAPID_SUBJECT: 'mailto:test@example.com',
};

const makePrismaMock = () => {
  const tx = {
    pushDeliveryJob: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    pushSubscription: {
      findUnique: vi.fn(),
    },
    notification: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(tx)),
  };
  const prisma = {
    ...tx,
    pushSubscription: {
      findUnique: vi.fn(),
    },
    pushDeliveryJob: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    notification: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(tx)),
  } as unknown as PrismaService;
  return { prisma, tx };
};

const makeClaimedJob = (overrides: Record<string, unknown> = {}) => ({
  id: 'job-1',
  notificationId: 'notif-1',
  userId: 'user-1',
  pushSubscriptionId: 'sub-1',
  status: 'PROCESSING',
  attempts: 0,
  maxAttempts: 5,
  nextAttemptAt: new Date(),
  lockedAt: new Date(),
  lockedBy: 'push-worker-test',
  leaseExpiresAt: new Date(Date.now() + 60000),
  lastErrorCode: null,
  lastErrorMessage: null,
  payload: { title: 'LOMOR', body: 'test', url: '/notifications' },
  sentAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  subscriptionId: 'sub-1',
  subscriptionUserId: 'user-1',
  subscriptionIsActive: true,
  subscriptionRevokedAt: null,
  subscriptionEndpoint: 'https://push.example.com/endpoint',
  subscriptionP256dh: 'p256dh-key',
  subscriptionAuth: 'auth-key',
  notificationUserId: 'user-1',
  ...overrides,
});

describe('PushDeliveryWorker', () => {
  let prisma: PrismaService;
  let tx: any;
  let delRepo: PushDeliveryRepository;
  let worker: PushDeliveryWorker;

  beforeEach(() => {
    const mocks = makePrismaMock();
    prisma = mocks.prisma;
    tx = mocks.tx;
    delRepo = new PushDeliveryRepository(prisma);
    const settings = readVapidSettings(VAPID_ENV);
    worker = new PushDeliveryWorker(settings, prisma, delRepo, {
      leaseTtlSeconds: 60,
      pollIntervalMs: 5000,
      leaseSweepIntervalMs: 30000,
      batchSize: 20,
      retryBackoffSeconds: [60, 300, 1800, 7200],
    });
    (worker as any).started = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isEnabled', () => {
    it('returns false when VAPID is not configured', () => {
      const settings = readVapidSettings({});
      const w = new PushDeliveryWorker(settings, prisma, delRepo, {
        leaseTtlSeconds: 60,
        pollIntervalMs: 5000,
        leaseSweepIntervalMs: 30000,
        batchSize: 20,
        retryBackoffSeconds: [60, 300, 1800, 7200],
      });
      expect(w.isEnabled).toBe(false);
    });
  });

  describe('runCycle', () => {
    it('does nothing when not enabled', async () => {
      const settings = readVapidSettings({});
      const w = new PushDeliveryWorker(settings, prisma, delRepo, {
        leaseTtlSeconds: 60,
        pollIntervalMs: 5000,
        leaseSweepIntervalMs: 30000,
        batchSize: 20,
        retryBackoffSeconds: [60, 300, 1800, 7200],
      });
      vi.spyOn(delRepo, 'claimJobs').mockResolvedValue([]);
      await w.runCycle();
      expect(delRepo.claimJobs).not.toHaveBeenCalled();
    });

    it('processes claimed jobs', async () => {
      const job = makeClaimedJob();
      vi.spyOn(delRepo, 'claimJobs').mockResolvedValue([job as any]);
      vi.spyOn(delRepo, 'findSubscriptionByIdForUpdate').mockResolvedValue({
        id: 'sub-1',
        userId: 'user-1',
        isActive: true,
        revokedAt: null,
        endpoint: 'https://push.example.com/endpoint',
        p256dh: 'p256dh-key',
        auth: 'auth-key',
      });
      vi.spyOn(delRepo, 'reserveAttempt').mockResolvedValue(true);
      vi.spyOn(delRepo, 'finalizeJob').mockResolvedValue(true);
      vi.spyOn(prisma, '$transaction').mockImplementation(async (work: any) => work(tx));
      vi.spyOn(prisma.pushSubscription, 'findUnique').mockResolvedValue({
        endpoint: 'https://push.example.com/endpoint',
        p256dh: 'p256dh-key',
        auth: 'auth-key',
      } as any);

      await worker.runCycle();
      expect(delRepo.claimJobs).toHaveBeenCalled();
    });

    it('prevents overlapping ticks', async () => {
      const job = makeClaimedJob();
      let resolveClaim: (v: any) => void;
      const claimPromise = new Promise((r) => { resolveClaim = r; });
      vi.spyOn(delRepo, 'claimJobs').mockReturnValue(claimPromise as any);

      const cycle1 = worker.runCycle();
      const cycle2 = worker.runCycle(); // should be no-op

      resolveClaim!([job]);
      await cycle1;
      await cycle2;

      expect(delRepo.claimJobs).toHaveBeenCalledTimes(1);
    });
  });

  describe('processJob - invalid subscription', () => {
    it('finalizes FAILED for missing subscription', async () => {
      const job = makeClaimedJob();
      vi.spyOn(delRepo, 'findSubscriptionByIdForUpdate').mockResolvedValue(null);
      vi.spyOn(delRepo, 'finalizeJob').mockResolvedValue(true);
      vi.spyOn(prisma, '$transaction').mockImplementation(async (work: any) => work(tx));

      await (worker as any).processJob(job);

      expect(delRepo.finalizeJob).toHaveBeenCalledWith(
        job.id,
        expect.any(String),
        expect.objectContaining({ lastErrorCode: 'SUBSCRIPTION_MISSING' }),
        expect.anything(),
      );
    });
  });

  describe('processJob - inactive subscription', () => {
    it('finalizes FAILED for inactive subscription', async () => {
      const job = makeClaimedJob();
      vi.spyOn(delRepo, 'findSubscriptionByIdForUpdate').mockResolvedValue({
        id: 'sub-1',
        userId: 'user-1',
        isActive: false,
        revokedAt: null,
        endpoint: 'https://push.example.com/endpoint',
        p256dh: 'p256dh-key',
        auth: 'auth-key',
      });
      vi.spyOn(delRepo, 'finalizeJob').mockResolvedValue(true);
      vi.spyOn(prisma, '$transaction').mockImplementation(async (work: any) => work(tx));

      await (worker as any).processJob(job);

      expect(delRepo.finalizeJob).toHaveBeenCalledWith(
        job.id,
        expect.any(String),
        expect.objectContaining({ lastErrorCode: 'SUBSCRIPTION_INACTIVE' }),
        expect.anything(),
      );
    });
  });

  describe('processJob - revoked subscription', () => {
    it('finalizes FAILED for revoked subscription', async () => {
      const job = makeClaimedJob();
      vi.spyOn(delRepo, 'findSubscriptionByIdForUpdate').mockResolvedValue({
        id: 'sub-1',
        userId: 'user-1',
        isActive: true,
        revokedAt: new Date(),
        endpoint: 'https://push.example.com/endpoint',
        p256dh: 'p256dh-key',
        auth: 'auth-key',
      });
      vi.spyOn(delRepo, 'finalizeJob').mockResolvedValue(true);
      vi.spyOn(prisma, '$transaction').mockImplementation(async (work: any) => work(tx));

      await (worker as any).processJob(job);

      expect(delRepo.finalizeJob).toHaveBeenCalledWith(
        job.id,
        expect.any(String),
        expect.objectContaining({ lastErrorCode: 'SUBSCRIPTION_REVOKED' }),
        expect.anything(),
      );
    });
  });

  describe('processJob - ownership mismatch', () => {
    it('finalizes FAILED for subscription ownership mismatch', async () => {
      const job = makeClaimedJob();
      vi.spyOn(delRepo, 'findSubscriptionByIdForUpdate').mockResolvedValue({
        id: 'sub-1',
        userId: 'different-user',
        isActive: true,
        revokedAt: null,
        endpoint: 'https://push.example.com/endpoint',
        p256dh: 'p256dh-key',
        auth: 'auth-key',
      });
      vi.spyOn(delRepo, 'finalizeJob').mockResolvedValue(true);
      vi.spyOn(prisma, '$transaction').mockImplementation(async (work: any) => work(tx));

      await (worker as any).processJob(job);

      expect(delRepo.finalizeJob).toHaveBeenCalledWith(
        job.id,
        expect.any(String),
        expect.objectContaining({ lastErrorCode: 'OWNERSHIP_MISMATCH' }),
        expect.anything(),
      );
    });
  });

  describe('processJob - max attempts', () => {
    it('finalizes FAILED at maxAttempts', async () => {
      const job = makeClaimedJob({ attempts: 5, maxAttempts: 5 });
      vi.spyOn(delRepo, 'findSubscriptionByIdForUpdate').mockResolvedValue({
        id: 'sub-1',
        userId: 'user-1',
        isActive: true,
        revokedAt: null,
        endpoint: 'https://push.example.com/endpoint',
        p256dh: 'p256dh-key',
        auth: 'auth-key',
      });
      vi.spyOn(delRepo, 'finalizeJob').mockResolvedValue(true);
      vi.spyOn(prisma, '$transaction').mockImplementation(async (work: any) => work(tx));

      await (worker as any).processJob(job);

      expect(delRepo.finalizeJob).toHaveBeenCalledWith(
        job.id,
        expect.any(String),
        expect.objectContaining({ lastErrorCode: 'MAX_ATTEMPTS' }),
        expect.anything(),
      );
    });
  });

  describe('processJob - reservation rejection', () => {
    it('does not proceed when reserveAttempt returns false', async () => {
      const job = makeClaimedJob();
      vi.spyOn(delRepo, 'findSubscriptionByIdForUpdate').mockResolvedValue({
        id: 'sub-1',
        userId: 'user-1',
        isActive: true,
        revokedAt: null,
        endpoint: 'https://push.example.com/endpoint',
        p256dh: 'p256dh-key',
        auth: 'auth-key',
      });
      vi.spyOn(delRepo, 'reserveAttempt').mockResolvedValue(false);
      vi.spyOn(delRepo, 'finalizeJob').mockResolvedValue(true);
      vi.spyOn(prisma, '$transaction').mockImplementation(async (work: any) => work(tx));

      await (worker as any).processJob(job);

      // Should not have called finalizeJob (fence lost, discarded)
      expect(delRepo.finalizeJob).not.toHaveBeenCalled();
    });
  });

  describe('runSweep', () => {
    it('calls sweepExpiredLeases', async () => {
      vi.spyOn(delRepo, 'sweepExpiredLeases').mockResolvedValue({ recovered: 2, failed: 1 });
      await worker.runSweep();
      expect(delRepo.sweepExpiredLeases).toHaveBeenCalled();
    });

    it('does nothing when not enabled', async () => {
      const settings = readVapidSettings({});
      const w = new PushDeliveryWorker(settings, prisma, delRepo, {
        leaseTtlSeconds: 60,
        pollIntervalMs: 5000,
        leaseSweepIntervalMs: 30000,
        batchSize: 20,
        retryBackoffSeconds: [60, 300, 1800, 7200],
      });
      vi.spyOn(delRepo, 'sweepExpiredLeases').mockResolvedValue({ recovered: 0, failed: 0 });
      await w.runSweep();
      expect(delRepo.sweepExpiredLeases).not.toHaveBeenCalled();
    });
  });

  describe('onModuleInit / onModuleDestroy', () => {
    it('starts timers when configured', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      worker.onModuleInit();
      expect(setIntervalSpy).toHaveBeenCalledTimes(2);
      worker.onModuleDestroy();
      setIntervalSpy.mockRestore();
    });

    it('does not start timers when not configured', () => {
      const settings = readVapidSettings({});
      const w = new PushDeliveryWorker(settings, prisma, delRepo, {
        leaseTtlSeconds: 60,
        pollIntervalMs: 5000,
        leaseSweepIntervalMs: 30000,
        batchSize: 20,
        retryBackoffSeconds: [60, 300, 1800, 7200],
      });
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      w.onModuleInit();
      expect(setIntervalSpy).not.toHaveBeenCalled();
      setIntervalSpy.mockRestore();
    });
  });
});
