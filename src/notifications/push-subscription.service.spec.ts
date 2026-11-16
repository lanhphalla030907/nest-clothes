import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { PushSubscriptionRepository } from './push-subscription.repository.js';
import { PushDeliveryRepository } from './push-delivery.repository.js';
import { PushSubscriptionService } from './push-subscription.service.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const ENDPOINT = 'https://push.example.com/endpoint-abc';

const makePrismaMock = () => {
  const tx = {
    pushSubscription: {
      create: vi.fn(),
      update: vi.fn(),
    },
    pushDeliveryJob: {
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(tx)),
  };
  return { prisma: { $transaction: tx.$transaction } as unknown as PrismaService, tx };
};

const makeSubscriptionRow = (
  id: string,
  userId: string,
): Record<string, unknown> => ({
  id,
  user_id: userId,
  endpoint: ENDPOINT,
  is_active: true,
  revoked_at: null,
});

describe('PushSubscriptionService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a subscription bound to the authenticated user when none exists', async () => {
    const { prisma, tx } = makePrismaMock();
    const subRepo = new PushSubscriptionRepository(prisma);
    const delRepo = new PushDeliveryRepository(prisma);
    const service = new PushSubscriptionService(prisma, subRepo, delRepo);

    vi.spyOn(subRepo, 'findByEndpointForUpdate').mockResolvedValue(null);
    vi.spyOn(subRepo, 'create').mockResolvedValue(makeSubscriptionRow('sub-1', USER_A));

    const result = await service.registerSubscription(ENDPOINT, 'p256dh', 'auth', null, USER_A);

    expect(subRepo.findByEndpointForUpdate).toHaveBeenCalledWith(ENDPOINT, tx);
    expect(subRepo.create).toHaveBeenCalled();
    expect(result).toEqual(makeSubscriptionRow('sub-1', USER_A));
  });

  it('refreshes keys and reactivates when the same owner re-registers', async () => {
    const { prisma, tx } = makePrismaMock();
    const subRepo = new PushSubscriptionRepository(prisma);
    const delRepo = new PushDeliveryRepository(prisma);
    const service = new PushSubscriptionService(prisma, subRepo, delRepo);

    const existing = makeSubscriptionRow('sub-1', USER_A);
    vi.spyOn(subRepo, 'findByEndpointForUpdate').mockResolvedValue(existing);
    vi.spyOn(subRepo, 'updateById').mockResolvedValue({ ...existing, p256dh: 'new-key' });

    const result = await service.registerSubscription(ENDPOINT, 'new-key', 'new-auth', null, USER_A);

    expect(subRepo.updateById).toHaveBeenCalledWith('sub-1', expect.objectContaining({
      p256dh: 'new-key',
      isActive: true,
      revokedAt: null,
    }), tx);
    expect(result).toEqual({ ...existing, p256dh: 'new-key' });
  });

  it('transfers ownership from User A to User B and terminalizes prior jobs', async () => {
    const { prisma, tx } = makePrismaMock();
    const subRepo = new PushSubscriptionRepository(prisma);
    const delRepo = new PushDeliveryRepository(prisma);
    const service = new PushSubscriptionService(prisma, subRepo, delRepo);

    const existing = makeSubscriptionRow('sub-1', USER_A);
    vi.spyOn(subRepo, 'findByEndpointForUpdate').mockResolvedValue(existing);
    vi.spyOn(subRepo, 'updateById').mockResolvedValue({ ...existing, userId: USER_B });
    vi.spyOn(subRepo, 'findByIdAndUser').mockResolvedValue({ ...existing, userId: USER_B });
    vi.spyOn(subRepo, 'markJobsOwnershipTransferred').mockResolvedValue(undefined);

    const result = await service.registerSubscription(ENDPOINT, 'new-key', 'new-auth', null, USER_B);

    expect(subRepo.updateById).toHaveBeenCalledWith('sub-1', expect.objectContaining({
      p256dh: 'new-key',
      auth: 'new-auth',
      userAgent: null,
      isActive: true,
      revokedAt: null,
      user: { connect: { id: USER_B } },
    }), tx);
    expect(subRepo.markJobsOwnershipTransferred).toHaveBeenCalledWith('sub-1', tx);
    expect(result).toEqual({ ...existing, userId: USER_B });
  });

  it('lists only active subscriptions for the authenticated user', async () => {
    const { prisma } = makePrismaMock();
    const subRepo = new PushSubscriptionRepository(prisma);
    const delRepo = new PushDeliveryRepository(prisma);
    const service = new PushSubscriptionService(prisma, subRepo, delRepo);

    const rows = [makeSubscriptionRow('sub-1', USER_A)];
    vi.spyOn(subRepo, 'findActiveByUser').mockResolvedValue(rows);

    const result = await service.listSubscriptions(USER_A);

    expect(subRepo.findActiveByUser).toHaveBeenCalledWith(USER_A);
    expect(result).toEqual(rows);
  });

  it('revokes a subscription owned by the user', async () => {
    const { prisma } = makePrismaMock();
    const subRepo = new PushSubscriptionRepository(prisma);
    const delRepo = new PushDeliveryRepository(prisma);
    const service = new PushSubscriptionService(prisma, subRepo, delRepo);

    vi.spyOn(subRepo, 'revoke').mockResolvedValue(true);

    const result = await service.revokeSubscription('sub-1', USER_A);

    expect(subRepo.revoke).toHaveBeenCalledWith('sub-1', USER_A);
    expect(result).toBe(true);
  });

  it('returns false when revoking a subscription not owned by the user', async () => {
    const { prisma } = makePrismaMock();
    const subRepo = new PushSubscriptionRepository(prisma);
    const delRepo = new PushDeliveryRepository(prisma);
    const service = new PushSubscriptionService(prisma, subRepo, delRepo);

    vi.spyOn(subRepo, 'revoke').mockResolvedValue(false);

    const result = await service.revokeSubscription('sub-1', USER_B);

    expect(result).toBe(false);
  });
});
