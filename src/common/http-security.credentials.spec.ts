import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { applyCors, parseCorsOrigins } from './http-security.config.js';

@Controller('cors-test')
class CorsTestController {
  @Get()
  get() {
    return { ok: true };
  }
}

async function buildApp(): Promise<INestApplication> {
  const module = await Test.createTestingModule({
    controllers: [CorsTestController],
  }).compile();
  const app = module.createNestApplication();
  applyCors(app);
  await app.init();
  return app;
}

describe('Credentialed CORS', () => {
  const previous = process.env.CORS_ALLOWED_ORIGINS;

  afterEach(() => {
    if (previous === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = previous;
  });

  it('allows a configured origin with credentials and the CSRF header', async () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://shop.example.com';
    const app = await buildApp();

    const response = await request(app.getHttpServer())
      .options('/cors-test')
      .set('Origin', 'https://shop.example.com')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'x-csrf-token')
      .expect(204);

    expect(response.headers['access-control-allow-origin']).toBe(
      'https://shop.example.com',
    );
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-allow-headers']).toContain('x-csrf-token');
    await app.close();
  });

  it('rejects an unconfigured origin', async () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://shop.example.com';
    const app = await buildApp();

    const response = await request(app.getHttpServer())
      .get('/cors-test')
      .set('Origin', 'https://attacker.example.com')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('never turns a wildcard configuration into a credentialed allowed origin', async () => {
    process.env.CORS_ALLOWED_ORIGINS = '*';
    expect(parseCorsOrigins('*', 'production')).toEqual([]);
    const app = await buildApp();

    const response = await request(app.getHttpServer())
      .get('/cors-test')
      .set('Origin', 'https://attacker.example.com')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    await app.close();
  });
});
