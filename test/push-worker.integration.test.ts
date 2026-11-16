import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { PushDeliveryStatus } from '../src/generated/prisma/enums.js';
import { randomUUID } from 'node:crypto';

const TEST_DB_URL = process.env.DATABASE_URL!;

function makePrisma() {
  const adapter = new PrismaPg({ connectionString: TEST_DB_URL });
  return new PrismaClient({ adapter });
}

function makeJobData(overrides: Record<string, unknown> = {}) {
  return {
    notificationId: null as string | null,
    userId: randomUUID(),
    pushSubscriptionId: randomUUID(),
    status: PushDeliveryStatus.PENDING,
    attempts: 0,
    maxAttempts: 5,
    nextAttemptAt: new Date(),
    payload: { title: 'LOMOR', body: 'test', url: '/notifications' },
    ...overrides,
  };
}

describe('Push Worker (PostgreSQL integration)', () => {
  let prismaA: PrismaClient;
  let prismaB: PrismaClient;
  const jobIds: string[] = [];
  const subIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    prismaA = makePrisma();
    prismaB = makePrisma();
    await prismaA.$connect();
    await prismaB.$connect();
  });

  afterAll(async () => {
    // Clean up test fixtures
    for (const id of jobIds) {
      await prismaA.pushDeliveryJob.deleteMany({ where: { id } }).catch(() => {});
    }
    for (const id of subIds) {
      await prismaA.pushSubscription.deleteMany({ where: { id } }).catch(() => {});
    }
    for (const id of userIds) {
      await prismaA.user.deleteMany({ where: { id } }).catch(() => {});
    }
    await prismaA.$disconnect();
    await prismaB.$disconnect();
  });

  it('concurrent claiming: no duplicate claims', async () => {
    // Create a user and subscription for the job
    const userId = randomUUID();
    const subId = randomUUID();
    userIds.push(userId);
    subIds.push(subId);

    await prismaA.user.create({
      data: {
        id: userId,
        firstName: 'Test',
        lastName: 'User',
        email: `test-${userId}@example.com`,
        passwordHash: 'hash',
        status: 'ACTIVE',
        role: 'CUSTOMER',
      },
    });

    await prismaA.pushSubscription.create({
      data: {
        id: subId,
        userId,
        endpoint: `https://push.example.com/${subId}`,
        p256dh: 'key',
        auth: 'auth',
        isActive: true,
      },
    });

    // Create 5 pending jobs
    const jobs = [];
    for (let i = 0; i < 5; i++) {
      const job = await prismaA.pushDeliveryJob.create({
        data: {
          notificationId: null,
          userId,
          pushSubscriptionId: subId,
          status: PushDeliveryStatus.PENDING,
          attempts: 0,
          maxAttempts: 5,
          nextAttemptAt: new Date(),
          payload: { title: 'LOMOR', body: 'test', url: '/notifications' },
        },
      });
      jobs.push(job);
      jobIds.push(job.id);
    }

    // Two workers claim concurrently
    const workerA = `worker-a-${randomUUID()}`;
    const workerB = `worker-b-${randomUUID()}`;
    const leaseTtl = 60;

    const [claimedA, claimedB] = await Promise.all([
      prismaA.$transaction(async (tx) => {
        const result = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `WITH due_jobs AS (
            SELECT j.id FROM "push_delivery_jobs" j
            WHERE j.status = $1 AND j.next_attempt_at <= $2 AND j.attempts < j."maxAttempts"
            ORDER BY j.next_attempt_at ASC, j.created_at ASC, j.id ASC
            FOR UPDATE SKIP LOCKED LIMIT $3
          )
          UPDATE "push_delivery_jobs" j SET status = $4, locked_at = $5, locked_by = $6, lease_expires_at = $7, updated_at = $8
          FROM due_jobs d WHERE j.id = d.id
          RETURNING j.id`,
          PushDeliveryStatus.PENDING,
          new Date(),
          3,
          PushDeliveryStatus.PROCESSING,
          new Date(),
          workerA,
          new Date(Date.now() + leaseTtl * 1000),
          new Date(),
        );
        return result;
      }),
      prismaB.$transaction(async (tx) => {
        const result = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `WITH due_jobs AS (
            SELECT j.id FROM "push_delivery_jobs" j
            WHERE j.status = $1 AND j.next_attempt_at <= $2 AND j.attempts < j."maxAttempts"
            ORDER BY j.next_attempt_at ASC, j.created_at ASC, j.id ASC
            FOR UPDATE SKIP LOCKED LIMIT $3
          )
          UPDATE "push_delivery_jobs" j SET status = $4, locked_at = $5, locked_by = $6, lease_expires_at = $7, updated_at = $8
          FROM due_jobs d WHERE j.id = d.id
          RETURNING j.id`,
          PushDeliveryStatus.PENDING,
          new Date(),
          3,
          PushDeliveryStatus.PROCESSING,
          new Date(),
          workerB,
          new Date(Date.now() + leaseTtl * 1000),
          new Date(),
        );
        return result;
      }),
    ]);

    const claimedIds = new Set([
      ...claimedA.map((r: any) => r.id),
      ...claimedB.map((r: any) => r.id),
    ]);

    // All 5 jobs should be claimed (3 + 2)
    expect(claimedIds.size).toBe(5);

    // No overlap
    const overlap = claimedA.filter((a: any) =>
      claimedB.some((b: any) => b.id === a.id),
    );
    expect(overlap.length).toBe(0);

    // Attempts unchanged
    const updatedJobs = await prismaA.pushDeliveryJob.findMany({
      where: { id: { in: jobs.map((j) => j.id) } },
    });
    for (const j of updatedJobs) {
      expect(j.attempts).toBe(0);
    }
  });

  it('lease fencing: stale worker cannot overwrite', async () => {
    const userId = randomUUID();
    const subId = randomUUID();
    userIds.push(userId);
    subIds.push(subId);

    await prismaA.user.create({
      data: {
        id: userId,
        firstName: 'Test',
        lastName: 'User',
        email: `test-${userId}@example.com`,
        passwordHash: 'hash',
        status: 'ACTIVE',
        role: 'CUSTOMER',
      },
    });

    await prismaA.pushSubscription.create({
      data: {
        id: subId,
        userId,
        endpoint: `https://push.example.com/${subId}`,
        p256dh: 'key',
        auth: 'auth',
        isActive: true,
      },
    });

    const job = await prismaA.pushDeliveryJob.create({
      data: {
        notificationId: null,
        userId,
        pushSubscriptionId: subId,
        status: PushDeliveryStatus.PENDING,
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: new Date(),
        payload: { title: 'LOMOR', body: 'test', url: '/notifications' },
      },
    });
    jobIds.push(job.id);

    const workerA = `worker-a-${randomUUID()}`;
    const workerB = `worker-b-${randomUUID()}`;

    // Worker A claims the job
    await prismaA.pushDeliveryJob.update({
      where: { id: job.id },
      data: {
        status: PushDeliveryStatus.PROCESSING,
        lockedBy: workerA,
        lockedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() - 1000), // already expired
      },
    });

    // Worker B recovers (sweeper-like) and reclaims
    await prismaB.pushDeliveryJob.updateMany({
      where: {
        id: job.id,
        status: PushDeliveryStatus.PROCESSING,
        lockedBy: workerA,
        leaseExpiresAt: { lt: new Date() },
      },
      data: {
        status: PushDeliveryStatus.PENDING,
        nextAttemptAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        leaseExpiresAt: null,
      },
    });

    // Worker B claims it
    await prismaB.pushDeliveryJob.update({
      where: { id: job.id },
      data: {
        status: PushDeliveryStatus.PROCESSING,
        lockedBy: workerB,
        lockedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 60000),
      },
    });

    // Worker A tries to finalize (should fail - fence lost)
    const result = await prismaA.pushDeliveryJob.updateMany({
      where: {
        id: job.id,
        status: PushDeliveryStatus.PROCESSING,
        lockedBy: workerA,
        leaseExpiresAt: { gt: new Date() },
      },
      data: {
        status: PushDeliveryStatus.SENT,
        sentAt: new Date(),
      },
    });

    expect(result.count).toBe(0);

    // Verify job is still owned by Worker B
    const finalJob = await prismaA.pushDeliveryJob.findUnique({
      where: { id: job.id },
    });
    expect(finalJob?.lockedBy).toBe(workerB);
    expect(finalJob?.status).toBe(PushDeliveryStatus.PROCESSING);
  });

  it('sweeper: expired lease below maxAttempts → PENDING', async () => {
    const userId = randomUUID();
    const subId = randomUUID();
    userIds.push(userId);
    subIds.push(subId);

    await prismaA.user.create({
      data: {
        id: userId,
        firstName: 'Test',
        lastName: 'User',
        email: `test-${userId}@example.com`,
        passwordHash: 'hash',
        status: 'ACTIVE',
        role: 'CUSTOMER',
      },
    });

    await prismaA.pushSubscription.create({
      data: {
        id: subId,
        userId,
        endpoint: `https://push.example.com/${subId}`,
        p256dh: 'key',
        auth: 'auth',
        isActive: true,
      },
    });

    const job = await prismaA.pushDeliveryJob.create({
      data: {
        notificationId: null,
        userId,
        pushSubscriptionId: subId,
        status: PushDeliveryStatus.PROCESSING,
        attempts: 2,
        maxAttempts: 5,
        nextAttemptAt: new Date(),
        payload: { title: 'LOMOR', body: 'test', url: '/notifications' },
        lockedBy: 'worker-x',
        lockedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() - 1000),
      },
    });
    jobIds.push(job.id);

    // Run sweeper logic
    const recovered = await prismaA.pushDeliveryJob.updateMany({
      where: {
        status: PushDeliveryStatus.PROCESSING,
        lockedBy: { not: 'current-worker' },
        leaseExpiresAt: { lt: new Date() },
        attempts: { lt: 5 },
      },
      data: {
        status: PushDeliveryStatus.PENDING,
        nextAttemptAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        leaseExpiresAt: null,
      },
    });

    expect(recovered.count).toBe(1);

    const updated = await prismaA.pushDeliveryJob.findUnique({
      where: { id: job.id },
    });
    expect(updated?.status).toBe(PushDeliveryStatus.PENDING);
    expect(updated?.attempts).toBe(2); // unchanged
  });

  it('sweeper: exhausted PENDING jobs → FAILED', async () => {
    const userId = randomUUID();
    const subId = randomUUID();
    userIds.push(userId);
    subIds.push(subId);

    await prismaA.user.create({
      data: {
        id: userId,
        firstName: 'Test',
        lastName: 'User',
        email: `test-${userId}@example.com`,
        passwordHash: 'hash',
        status: 'ACTIVE',
        role: 'CUSTOMER',
      },
    });

    await prismaA.pushSubscription.create({
      data: {
        id: subId,
        userId,
        endpoint: `https://push.example.com/${subId}`,
        p256dh: 'key',
        auth: 'auth',
        isActive: true,
      },
    });

    const job = await prismaA.pushDeliveryJob.create({
      data: {
        notificationId: null,
        userId,
        pushSubscriptionId: subId,
        status: PushDeliveryStatus.PENDING,
        attempts: 5,
        maxAttempts: 5,
        nextAttemptAt: new Date(),
        payload: { title: 'LOMOR', body: 'test', url: '/notifications' },
      },
    });
    jobIds.push(job.id);

    const failed = await prismaA.pushDeliveryJob.updateMany({
      where: {
        status: PushDeliveryStatus.PENDING,
        attempts: { gte: 5 },
      },
      data: {
        status: PushDeliveryStatus.FAILED,
        lastErrorCode: 'MAX_ATTEMPTS',
      },
    });

    expect(failed.count).toBeGreaterThanOrEqual(1);

    const updated = await prismaA.pushDeliveryJob.findUnique({
      where: { id: job.id },
    });
    expect(updated?.status).toBe(PushDeliveryStatus.FAILED);
    expect(updated?.attempts).toBe(5); // unchanged
  });
});
