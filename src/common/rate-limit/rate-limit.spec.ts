import { APP_GUARD } from '@nestjs/core';
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  type INestApplication,
  type Type,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { AuthController } from '../../auth/auth.controller.js';
import { CheckoutController } from '../../checkout/checkout.controller.js';
import { PaymentsController } from '../../payments/payments.controller.js';
import { UsersController } from '../../users/users.controller.js';
import {
  createThrottlerOptions,
  parseTrustedProxySetting,
  RATE_LIMIT_POLICIES,
} from './rate-limit.config.js';
import { LomorThrottlerGuard } from './lomor-throttler.guard.js';

@Controller('rate-test')
class RateTestController {
  @Get()
  @Throttle({ testLimit: { limit: 2, ttl: 60_000 } })
  get() {
    return { ok: true };
  }
}

@Controller('unrestricted')
class UnrestrictedTestController {
  @Get()
  get() {
    return { ok: true };
  }
}

@Controller('auth')
class RefreshTestController {
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh() {
    return { ok: true };
  }
}

@Controller('admin/orders')
class AdminOrdersTestController {
  @Get()
  findAll() {
    return { ok: true };
  }
}

@Controller('auth/login-test')
class LoginTestController {
  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: {
      limit: RATE_LIMIT_POLICIES.login.limit,
      ttl: RATE_LIMIT_POLICIES.login.ttl,
    },
  })
  login() {
    return { ok: true };
  }
}

@Controller('auth/forgot-test')
class ForgotPasswordTestController {
  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: {
      limit: RATE_LIMIT_POLICIES.forgotPassword.limit,
      ttl: RATE_LIMIT_POLICIES.forgotPassword.ttl,
    },
  })
  forgotPassword() {
    return { ok: true };
  }
}

const buildApp = async (controllers: Type[]): Promise<INestApplication> => {
  const module = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot(createThrottlerOptions())],
    controllers,
    providers: [
      {
        provide: APP_GUARD,
        useClass: LomorThrottlerGuard,
      },
    ],
  }).compile();

  const app = module.createNestApplication();
  app.getHttpAdapter().getInstance().set('trust proxy', false);
  await app.init();
  return app;
};

describe('centralized rate limiting', () => {
  it('defines every Phase 2 policy with the exact window and limit', () => {
    expect(RATE_LIMIT_POLICIES).toMatchObject({
      baseline: { limit: 100, ttl: 60_000 },
      login: { limit: 5, ttl: 60_000 },
      googleLogin: { limit: 10, ttl: 60_000 },
      registration: { limit: 5, ttl: 60 * 60_000 },
      forgotPassword: { limit: 3, ttl: 15 * 60_000 },
      resetPassword: { limit: 5, ttl: 15 * 60_000 },
      checkoutQuote: { limit: 20, ttl: 60_000 },
      orderCreation: { limit: 10, ttl: 60_000 },
    });
  });

  it('registers exactly one global default throttler', () => {
    expect(createThrottlerOptions()).toEqual({
      throttlers: [{ name: 'default', limit: 100, ttl: 60_000 }],
    });
  });

  it('applies exact route metadata to the verified controller paths', () => {
    const limit = (target: object, name: string) =>
      Reflect.getMetadata(`THROTTLER:LIMIT${name}`, target);
    const ttl = (target: object, name: string) =>
      Reflect.getMetadata(`THROTTLER:TTL${name}`, target);

    expect(limit(AuthController.prototype.login, 'default')).toBe(5);
    expect(ttl(AuthController.prototype.login, 'default')).toBe(60_000);
    expect(limit(AuthController.prototype.googleLogin, 'default')).toBe(10);
    expect(ttl(AuthController.prototype.googleLogin, 'default')).toBe(60_000);
    expect(limit(AuthController.prototype.forgotPassword, 'default')).toBe(3);
    expect(ttl(AuthController.prototype.forgotPassword, 'default')).toBe(15 * 60_000);
    expect(limit(AuthController.prototype.resetPassword, 'default')).toBe(5);
    expect(ttl(AuthController.prototype.resetPassword, 'default')).toBe(15 * 60_000);
    expect(limit(UsersController.prototype.create, 'default')).toBe(5);
    expect(ttl(UsersController.prototype.create, 'default')).toBe(60 * 60_000);
    expect(limit(CheckoutController.prototype.createQuote, 'default')).toBe(20);
    expect(ttl(CheckoutController.prototype.createQuote, 'default')).toBe(60_000);
    expect(limit(CheckoutController.prototype.checkout, 'default')).toBe(10);
    expect(ttl(CheckoutController.prototype.checkout, 'default')).toBe(60_000);

    // No legacy named metadata remains; the policies above are default overrides.
    expect(limit(AuthController.prototype.login, 'login')).toBeUndefined();
    expect(limit(AuthController.prototype.forgotPassword, 'forgotPassword')).toBeUndefined();
    expect(limit(CheckoutController.prototype.checkout, 'orderCreation')).toBeUndefined();
  });

  it('skips the default limiter for the PayWay callback', () => {
    expect(
      Reflect.getMetadata(
        'THROTTLER:SKIPdefault',
        PaymentsController.prototype.handlePaywayCallback,
      ),
    ).toBe(true);
  });

  it('accepts only explicit trusted proxy IP or CIDR values', () => {
    expect(parseTrustedProxySetting(undefined)).toBe(false);
    expect(parseTrustedProxySetting('')).toBe(false);
    expect(parseTrustedProxySetting('10.0.0.0/8,127.0.0.1')).toBe(
      '10.0.0.0/8,127.0.0.1',
    );
    expect(parseTrustedProxySetting('203.0.113.9')).toBe('203.0.113.9');
    expect(parseTrustedProxySetting('true')).toBe(false);
    expect(parseTrustedProxySetting('10.0.0.999/8')).toBe(false);
  });

  it('returns 429 and standard rate-limit headers, ignoring untrusted forwarding headers', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [{ name: 'testLimit', limit: 2, ttl: 60_000 }],
        }),
      ],
      controllers: [RateTestController],
      providers: [
        {
          provide: APP_GUARD,
          useClass: LomorThrottlerGuard,
        },
      ],
    }).compile();

    const app: INestApplication = module.createNestApplication();
    app.getHttpAdapter().getInstance().set('trust proxy', false);
    await app.init();

    await request(app.getHttpServer())
      .get('/rate-test')
      .set('X-Forwarded-For', '203.0.113.1')
      .expect(200);
    await request(app.getHttpServer())
      .get('/rate-test')
      .set('X-Forwarded-For', '203.0.113.2')
      .expect(200);

    const blocked = await request(app.getHttpServer())
      .get('/rate-test')
      .set('X-Forwarded-For', '203.0.113.3')
      .expect(429);

    expect(blocked.headers['retry-after-testlimit']).toBeDefined();
    expect(blocked.headers['x-ratelimit-limit']).toBe('2');
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
    expect(blocked.headers['x-ratelimit-reset']).toBeDefined();

    await app.close();
  });

  it('does not apply login or forgot-password limits to unrestricted routes or refresh', async () => {
    const app = await buildApp([UnrestrictedTestController, RefreshTestController]);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await request(app.getHttpServer()).get('/unrestricted').expect(200);
      await request(app.getHttpServer()).post('/auth/refresh').expect(200);
    }

    await app.close();
  });

  it('blocks login on the sixth request in its configured window', async () => {
    const app = await buildApp([LoginTestController]);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app.getHttpServer()).post('/auth/login-test').expect(200);
    }
    await request(app.getHttpServer()).post('/auth/login-test').expect(429);

    await app.close();
  });

  it('blocks forgot-password on the fourth request in its configured window', async () => {
    const app = await buildApp([ForgotPasswordTestController]);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(app.getHttpServer()).post('/auth/forgot-test').expect(200);
    }
    await request(app.getHttpServer()).post('/auth/forgot-test').expect(429);

    await app.close();
  });

  it('allows seven parallel GET /admin/orders requests from one dashboard load', async () => {
    const app = await buildApp([AdminOrdersTestController]);

    const responses = await Promise.all(
      Array.from({ length: 7 }, () =>
        request(app.getHttpServer()).get('/admin/orders').expect(200),
      ),
    );

    expect(responses).toHaveLength(7);
    await app.close();
  });
});
