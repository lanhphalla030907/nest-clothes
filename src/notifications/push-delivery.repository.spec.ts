import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { PushDeliveryRepository } from './push-delivery.repository.js';

const NOTIFICATION_ID = 'n-1';
const SUB_ID_1 = 'sub-1';
const USER_A = '11111111-1111-4111-8111-111111111111';

const makePrismaMock = () => {
  const prisma = {
    pushDeliveryJob: {
      createMany: vi.fn(),
    },
  } as unknown as PrismaService;
  return prisma;
};

describe('PushDeliveryRepository', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates jobs with PENDING status, attempts 0, maxAttempts 5', async () => {
    const prisma = makePrismaMock();
    const repo = new PushDeliveryRepository(prisma);

    vi.spyOn(prisma.pushDeliveryJob, 'createMany').mockResolvedValue({ count: 2 });

    const jobs = [
      { notificationId: NOTIFICATION_ID, userId: USER_A, pushSubscriptionId: SUB_ID_1, payload: {} },
      { notificationId: NOTIFICATION_ID, userId: USER_A, pushSubscriptionId: 'sub-2', payload: {} },
    ];

    const count = await repo.enqueueMany(jobs);

    expect(count).toBe(2);
    expect(prisma.pushDeliveryJob.createMany).toHaveBeenCalledWith({
      data: [
        {
          notificationId: NOTIFICATION_ID,
          userId: USER_A,
          pushSubscriptionId: SUB_ID_1,
          status: 'PENDING',
          attempts: 0,
          maxAttempts: 5,
          nextAttemptAt: expect.any(Date),
          payload: {},
        },
        {
          notificationId: NOTIFICATION_ID,
          userId: USER_A,
          pushSubscriptionId: 'sub-2',
          status: 'PENDING',
          attempts: 0,
          maxAttempts: 5,
          nextAttemptAt: expect.any(Date),
          payload: {},
        },
      ],
      skipDuplicates: true,
    });
  });

  it('returns 0 for an empty job list', async () => {
    const prisma = makePrismaMock();
    const repo = new PushDeliveryRepository(prisma);

    const count = await repo.enqueueMany([]);

    expect(count).toBe(0);
    expect(prisma.pushDeliveryJob.createMany).not.toHaveBeenCalled();
  });
});
