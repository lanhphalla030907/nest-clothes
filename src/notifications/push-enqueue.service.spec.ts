import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { PushSubscriptionRepository } from './push-subscription.repository.js';
import { PushDeliveryRepository } from './push-delivery.repository.js';
import { PushEnqueueService } from './push-enqueue.service.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const NOTIFICATION_ID = 'n-1';
const SUB_ID_1 = 'sub-1';
const SUB_ID_2 = 'sub-2';

const makePrismaMock = () => {
  const prisma = {
    notification: {
      findMany: vi.fn(),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work({})),
  } as unknown as PrismaService;
  return prisma;
};

const makeSubscription = (id: string, _userId: string) => ({
  id,
  userAgent: 'Mozilla/5.0',
  isActive: true,
  createdAt: new Date(),
});

describe('PushEnqueueService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates one PENDING job per active subscription', async () => {
    const prisma = makePrismaMock();
    const subRepo = new PushSubscriptionRepository(prisma);
    const delRepo = new PushDeliveryRepository(prisma);
    const service = new PushEnqueueService(prisma, subRepo, delRepo);

    vi.spyOn(subRepo, 'findActiveByUser').mockResolvedValue([
      makeSubscription(SUB_ID_1, USER_A),
      makeSubscription(SUB_ID_2, USER_A),
    ]);
    vi.spyOn(delRepo, 'enqueueMany').mockResolvedValue(2);

    await service.enqueueForNotification(NOTIFICATION_ID, USER_A, null);

    expect(delRepo.enqueueMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          notificationId: NOTIFICATION_ID,
          userId: USER_A,
          pushSubscriptionId: SUB_ID_1,
          status: 'PENDING',
        }),
        expect.objectContaining({
          notificationId: NOTIFICATION_ID,
          userId: USER_A,
          pushSubscriptionId: SUB_ID_2,
        }),
      ]),
      prisma,
    );
  });

  it('creates no jobs when there are no active subscriptions', async () => {
    const prisma = makePrismaMock();
    const subRepo = new PushSubscriptionRepository(prisma);
    const delRepo = new PushDeliveryRepository(prisma);
    const service = new PushEnqueueService(prisma, subRepo, delRepo);

    vi.spyOn(subRepo, 'findActiveByUser').mockResolvedValue([]);
    const enqueueSpy = vi.spyOn(delRepo, 'enqueueMany').mockResolvedValue(0);

    await service.enqueueForNotification(NOTIFICATION_ID, USER_A, null);

    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('enqueues for all notifications of a user since a timestamp', async () => {
    const prisma = makePrismaMock();
    const subRepo = new PushSubscriptionRepository(prisma);
    const delRepo = new PushDeliveryRepository(prisma);
    const service = new PushEnqueueService(prisma, subRepo, delRepo);

    const since = new Date('2026-01-01T00:00:00Z');
    vi.spyOn(prisma.notification, 'findMany').mockResolvedValue([
      { id: 'n-1' },
      { id: 'n-2' },
    ]);
    vi.spyOn(subRepo, 'findActiveByUser').mockResolvedValue([
      makeSubscription(SUB_ID_1, USER_A),
    ]);
    vi.spyOn(delRepo, 'enqueueMany').mockResolvedValue(2);

    await service.enqueueForUserSince(USER_A, since, null);

    expect(prisma.notification.findMany).toHaveBeenCalledWith({
      where: { userId: USER_A, createdAt: { gte: since } },
      select: { id: true },
    });
    expect(delRepo.enqueueMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ notificationId: 'n-1', pushSubscriptionId: SUB_ID_1 }),
        expect.objectContaining({ notificationId: 'n-2', pushSubscriptionId: SUB_ID_1 }),
      ]),
      prisma,
    );
  });

  it('swallows enqueue errors and does not throw', async () => {
    const prisma = makePrismaMock();
    const subRepo = new PushSubscriptionRepository(prisma);
    const delRepo = new PushDeliveryRepository(prisma);
    const service = new PushEnqueueService(prisma, subRepo, delRepo);

    vi.spyOn(subRepo, 'findActiveByUser').mockResolvedValue([
      makeSubscription(SUB_ID_1, USER_A),
    ]);
    vi.spyOn(delRepo, 'enqueueMany').mockRejectedValue(new Error('db down'));

    await expect(service.enqueueForNotification(NOTIFICATION_ID, USER_A, null)).resolves.toBeUndefined();
  });
});
