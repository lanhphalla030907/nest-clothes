import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  applyCors,
  applySecurityHeaders,
  parseCorsOrigins,
} from './http-security.config.js';

@Controller('security-test')
class SecurityTestController {
  @Get()
  get() {
    return { ok: true };
  }
}

describe('HTTP security configuration', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousOrigins = process.env.CORS_ALLOWED_ORIGINS;

  afterEach(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;

    if (previousOrigins === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = previousOrigins;
  });

  it('allows only configured origins in production', () => {
    expect(
      parseCorsOrigins(
        'https://shop.example.com, https://admin.example.com',
        'production',
      ),
    ).toEqual(['https://shop.example.com', 'https://admin.example.com']);
    expect(parseCorsOrigins(undefined, 'production')).toEqual([]);
  });

  it('allows explicit local development origins by default', () => {
    expect(parseCorsOrigins(undefined, 'development')).toContain(
      'http://localhost:5173',
    );
  });

  it('sets baseline security headers and rejects unlisted browser origins', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = 'https://shop.example.com';

    const module = await Test.createTestingModule({
      controllers: [SecurityTestController],
    }).compile();
    const app: INestApplication = module.createNestApplication();
    applyCors(app);
    applySecurityHeaders(app);
    await app.init();

    const allowed = await request(app.getHttpServer())
      .get('/security-test')
      .set('Origin', 'https://shop.example.com')
      .expect(200);
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'https://shop.example.com',
    );
    expect(allowed.headers['x-content-type-options']).toBe('nosniff');
    expect(allowed.headers['x-frame-options']).toBe('DENY');
    expect(allowed.headers['referrer-policy']).toBe('no-referrer');
    expect(allowed.headers['permissions-policy']).toBeDefined();
    expect(allowed.headers['strict-transport-security']).toContain('max-age');

    const denied = await request(app.getHttpServer())
      .get('/security-test')
      .set('Origin', 'https://attacker.example.com')
      .expect(200);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();

    await app.close();
  });
});
