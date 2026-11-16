import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { PushSubscriptionController } from './push-subscription.controller.js';
import { PushSubscriptionService } from './push-subscription.service.js';
import { RegisterSubscriptionDto } from './push-subscription.dto.js';

const USER_A = '11111111-1111-4111-8111-111111111111';

const makeUser = (id: string): AuthenticatedUser => ({
  id,
  email: `${id}@example.test`,
  role: 'CUSTOMER' as const,
});

const makeService = () => ({
  registerSubscription: vi.fn(),
  listSubscriptions: vi.fn(),
  revokeSubscription: vi.fn(),
});

describe('PushSubscriptionController', () => {
  it('register derives userId from JWT, never from body', async () => {
    const service = makeService();
    service.registerSubscription.mockResolvedValue({
      id: 'sub-1',
      userAgent: null,
      isActive: true,
      createdAt: new Date(),
    });
    const controller = new PushSubscriptionController(service as unknown as PushSubscriptionService);

    const dto = new RegisterSubscriptionDto();
    dto.endpoint = 'https://push.example.com/ep';
    dto.p256dh = 'key';
    dto.auth = 'auth';

    await controller.register(makeUser(USER_A), dto);

    expect(service.registerSubscription).toHaveBeenCalledWith(
      'https://push.example.com/ep',
      'key',
      'auth',
      null,
      USER_A,
    );
  });

  it('lists subscriptions scoped to the authenticated user', async () => {
    const service = makeService();
    service.listSubscriptions.mockResolvedValue([]);
    const controller = new PushSubscriptionController(service as unknown as PushSubscriptionService);

    const result = await controller.list(makeUser(USER_A), {});

    expect(service.listSubscriptions).toHaveBeenCalledWith(USER_A);
    expect(result).toEqual([]);
  });

  it('revokes subscription owned by the user', async () => {
    const service = makeService();
    service.revokeSubscription.mockResolvedValue(true);
    const controller = new PushSubscriptionController(service as unknown as PushSubscriptionService);

    const result = await controller.revoke(makeUser(USER_A), 'sub-1');

    expect(service.revokeSubscription).toHaveBeenCalledWith('sub-1', USER_A);
    expect(result).toBeUndefined();
  });
});
