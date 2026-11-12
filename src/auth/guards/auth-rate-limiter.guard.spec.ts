import { HttpException, HttpStatus, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthRateLimitOptions } from './auth-rate-limit.decorator.js';
import { AuthRateLimiterGuard } from './auth-rate-limiter.guard.js';

const buildContext = (path: string): ExecutionContext => {
  const request = {
    path,
    headers: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  };

  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
};

const buildGuard = (options: AuthRateLimitOptions | undefined) => {
  const reflector = {
    getAllAndOverride: vi.fn().mockReturnValue(options),
  } as unknown as Reflector;

  return new AuthRateLimiterGuard(reflector);
};

describe('AuthRateLimiterGuard', () => {
  it('uses the per-handler limit when one is declared', () => {
    const guard = buildGuard({ limit: 2, windowMs: 60_000 });
    const context = buildContext('/auth/forgot-password');

    expect(guard.canActivate(context)).toBe(true);
    expect(guard.canActivate(context)).toBe(true);
    expect(() => guard.canActivate(context)).toThrow(HttpException);

    try {
      guard.canActivate(context);
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  });

  it('keeps separate budgets per auth path', () => {
    const guard = buildGuard({ limit: 1, windowMs: 60_000 });
    const forgot = buildContext('/auth/forgot-password');
    const reset = buildContext('/auth/reset-password');

    expect(guard.canActivate(forgot)).toBe(true);
    expect(guard.canActivate(reset)).toBe(true);
    expect(() => guard.canActivate(forgot)).toThrow(HttpException);
    expect(() => guard.canActivate(reset)).toThrow(HttpException);
  });
});
