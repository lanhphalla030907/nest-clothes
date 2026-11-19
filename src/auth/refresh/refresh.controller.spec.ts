import {
  ConflictException,
  UnauthorizedException,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import {
  REFRESH_CSRF_COOKIE,
  REFRESH_SESSION_COOKIE,
} from './refresh-token.constants.js';
import { RefreshController } from './refresh.controller.js';
import {
  RefreshTokenService,
  type RotatedRefreshSession,
} from './refresh-token.service.js';

const ALLOWED_ORIGIN = 'https://shop.example.com';
const OPERATION_KEY = randomBytes(32).toString('base64url');
const REFRESH_TOKEN = 'current-refresh-token';
const CSRF_TOKEN = 'current-csrf-token';

const rotated = (): RotatedRefreshSession =>
  ({
    rawRefreshToken: 'replacement-refresh-token',
    rawCsrfToken: 'replacement-csrf-token',
    accessToken: 'new.access.token',
    expiresIn: '15m',
    session: { expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
    userId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  }) as unknown as RotatedRefreshSession;

const unauthorized = (code: string) =>
  new UnauthorizedException({ code, message: 'Invalid refresh session' });

const cookieHeader = (
  refresh = REFRESH_TOKEN,
  csrf = CSRF_TOKEN,
): string => `${REFRESH_SESSION_COOKIE}=${refresh}; ${REFRESH_CSRF_COOKIE}=${csrf}`;

describe('RefreshController (POST /auth/refresh)', () => {
  let app: INestApplication;
  let service: {
    rotate: ReturnType<typeof vi.fn>;
    hashOperationKey: ReturnType<typeof vi.fn>;
    csrfBindingMatches: ReturnType<typeof vi.fn>;
  };
  let previousOrigins: string | undefined;

  beforeAll(() => {
    previousOrigins = process.env.CORS_ALLOWED_ORIGINS;
    process.env.CORS_ALLOWED_ORIGINS = ALLOWED_ORIGIN;
  });

  afterAll(() => {
    if (previousOrigins === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = previousOrigins;
  });

  beforeEach(async () => {
    service = {
      rotate: vi.fn().mockResolvedValue(rotated()),
      hashOperationKey: vi.fn(() => 'operation-hash'),
      csrfBindingMatches: vi.fn().mockResolvedValue(true),
    };
    const module = await Test.createTestingModule({
      controllers: [RefreshController],
      providers: [{ provide: RefreshTokenService, useValue: service }],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const post = () =>
    request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Cookie', cookieHeader())
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ operationKey: OPERATION_KEY });

  it('returns only accessToken/expiresIn and sets both cookies on success', async () => {
    const response = await post().expect(200);

    expect(Object.keys(response.body).sort()).toEqual(['accessToken', 'expiresIn']);
    expect(response.body.accessToken).toBe('new.access.token');
    expect(response.body.expiresIn).toBe('15m');
    expect(JSON.stringify(response.body)).not.toContain('replacement-refresh-token');
    expect(service.rotate).toHaveBeenCalledWith(REFRESH_TOKEN, OPERATION_KEY);

    const cookies = response.headers['set-cookie'] as string[];
    expect(cookies).toHaveLength(2);
    const refreshCookie = cookies.find((item) => item.startsWith(`${REFRESH_SESSION_COOKIE}=`));
    const csrfCookie = cookies.find((item) => item.startsWith(`${REFRESH_CSRF_COOKIE}=`));
    expect(refreshCookie).toContain('replacement-refresh-token');
    expect(refreshCookie).toContain('HttpOnly');
    expect(csrfCookie).toContain('replacement-csrf-token');
    expect(csrfCookie).not.toContain('HttpOnly');
  });

  it('rejects a missing refresh cookie without rotating', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Cookie', `${REFRESH_CSRF_COOKIE}=${CSRF_TOKEN}`)
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ operationKey: OPERATION_KEY })
      .expect(401);

    expect(service.rotate).not.toHaveBeenCalled();
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it.each([
    ['missing CSRF cookie', cookieHeader(REFRESH_TOKEN, ''), undefined],
    ['missing CSRF header', cookieHeader(), undefined],
    ['mismatched CSRF header', cookieHeader(), 'wrong-csrf-token'],
  ])('rejects %s without rotating or revoking', async (_label, cookie, csrfHeader) => {
    const req = request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Cookie', cookie);
    if (csrfHeader) req.set('x-csrf-token', csrfHeader);
    const response = await req.send({ operationKey: OPERATION_KEY }).expect(403);

    expect(service.rotate).not.toHaveBeenCalled();
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a double-submit value bound to a different session', async () => {
    service.csrfBindingMatches.mockResolvedValueOnce(false);
    const response = await post().expect(403);

    expect(service.csrfBindingMatches).toHaveBeenCalledWith(REFRESH_TOKEN, CSRF_TOKEN);
    expect(service.rotate).not.toHaveBeenCalled();
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a malformed operation key before rotation', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Cookie', cookieHeader())
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ operationKey: 'too-short' })
      .expect(400);

    expect(service.rotate).not.toHaveBeenCalled();
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a non-canonical 43-character operation key before rotation', async () => {
    service.hashOperationKey.mockImplementationOnce(() => {
      throw new UnauthorizedException('Invalid refresh session');
    });

    const response = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Cookie', cookieHeader())
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ operationKey: `${'A'.repeat(42)}B` })
      .expect(400);

    expect(service.hashOperationKey).toHaveBeenCalled();
    expect(service.rotate).not.toHaveBeenCalled();
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('keeps cookies untouched for a stale replay', async () => {
    service.rotate.mockRejectedValueOnce(unauthorized('REFRESH_REPLAY_STALE'));
    const response = await post().expect(401);

    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('clears cookies for confirmed token reuse', async () => {
    service.rotate.mockRejectedValueOnce(unauthorized('REFRESH_TOKEN_REUSE'));
    const response = await post().expect(401);

    const cookies = response.headers['set-cookie'] as string[];
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) {
      expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970/);
    }
  });

  it('clears cookies for a binding mismatch', async () => {
    service.rotate.mockRejectedValueOnce(
      unauthorized('REFRESH_OPERATION_BINDING_MISMATCH'),
    );
    const response = await post().expect(401);

    expect(response.headers['set-cookie']).toHaveLength(2);
  });

  it('does not alter cookies for an expired idempotency result', async () => {
    service.rotate.mockRejectedValueOnce(unauthorized('REFRESH_OPERATION_EXPIRED'));
    const response = await post().expect(401);

    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('does not alter cookies for a transient conflict', async () => {
    service.rotate.mockRejectedValueOnce(new ConflictException('retry'));
    const response = await post().expect(409);

    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('rejects an origin outside the configured CORS list', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Origin', 'https://attacker.example.com')
      .set('Cookie', cookieHeader())
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ operationKey: OPERATION_KEY })
      .expect(403);

    expect(service.rotate).not.toHaveBeenCalled();
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('accepts a valid Referer when no Origin is sent', async () => {
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Referer', `${ALLOWED_ORIGIN}/checkout`)
      .set('Cookie', cookieHeader())
      .set('x-csrf-token', CSRF_TOKEN)
      .send({ operationKey: OPERATION_KEY })
      .expect(200);

    expect(service.rotate).toHaveBeenCalledTimes(1);
  });
});
