import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  REFRESH_CSRF_COOKIE,
  REFRESH_SESSION_COOKIE,
} from './refresh-token.constants.js';
import { RefreshController } from './refresh.controller.js';
import { RefreshTokenService } from './refresh-token.service.js';

const ORIGIN = 'https://shop.example.com';
const TOKEN = 'current-refresh-token';
const CSRF = 'current-csrf-token';

describe('POST /auth/logout', () => {
  let app: INestApplication;
  let service: {
    findActiveFamilyId: ReturnType<typeof vi.fn>;
    revokeFamily: ReturnType<typeof vi.fn>;
    hashOperationKey: ReturnType<typeof vi.fn>;
    rotate: ReturnType<typeof vi.fn>;
    csrfBindingMatches: ReturnType<typeof vi.fn>;
  };
  let previousOrigins: string | undefined;

  beforeAll(() => {
    previousOrigins = process.env.CORS_ALLOWED_ORIGINS;
    process.env.CORS_ALLOWED_ORIGINS = ORIGIN;
  });

  afterAll(() => {
    if (previousOrigins === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = previousOrigins;
  });

  beforeEach(async () => {
    service = {
      findActiveFamilyId: vi.fn().mockResolvedValue('family-1'),
      revokeFamily: vi.fn().mockResolvedValue(2),
      hashOperationKey: vi.fn(() => 'hash'),
      rotate: vi.fn(),
      csrfBindingMatches: vi.fn().mockResolvedValue(true),
    };
    const module = await Test.createTestingModule({
      controllers: [RefreshController],
      providers: [{ provide: RefreshTokenService, useValue: service }],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (refresh?: string, csrf = CSRF) => {
    const req = request(app.getHttpServer())
      .post('/auth/logout')
      .set('Origin', ORIGIN);
    if (refresh !== undefined) {
      const cookie = csrf
        ? `${REFRESH_SESSION_COOKIE}=${refresh}; ${REFRESH_CSRF_COOKIE}=${csrf}`
        : `${REFRESH_SESSION_COOKIE}=${refresh}`;
      req.set('Cookie', cookie);
    }
    if (csrf) req.set('x-csrf-token', csrf);
    return req;
  };

  const clearedCookies = (response: request.Response): string[] => {
    const cookies = response.headers['set-cookie'] as string[];
    expect(cookies).toHaveLength(2);
    return cookies;
  };

  it('revokes the correct family and clears both cookies with 204', async () => {
    const response = await post(TOKEN).expect(204);

    expect(service.findActiveFamilyId).toHaveBeenCalledWith(TOKEN);
    expect(service.revokeFamily).toHaveBeenCalledTimes(1);
    expect(service.revokeFamily).toHaveBeenCalledWith('family-1', 'logout');
    expect(response.text).toBe('');
    expect(clearedCookies(response)).toHaveLength(2);
  });

  it('uses explicit clearing attributes on both cookies', async () => {
    const response = await post(TOKEN).expect(204);
    const cookies = clearedCookies(response);
    const refresh = cookies.find((item) => item.startsWith(`${REFRESH_SESSION_COOKIE}=`));
    const csrf = cookies.find((item) => item.startsWith(`${REFRESH_CSRF_COOKIE}=`));

    for (const cookie of [refresh!, csrf!]) {
      expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain('SameSite=Lax');
    }
    expect(refresh).toContain('HttpOnly');
    expect(csrf).not.toContain('HttpOnly');
  });

  it('clears cookies and returns 204 when the refresh cookie is missing', async () => {
    const response = await post().expect(204);

    expect(service.findActiveFamilyId).not.toHaveBeenCalled();
    expect(service.revokeFamily).not.toHaveBeenCalled();
    clearedCookies(response);
  });

  it('clears cookies and returns 204 for an invalid or expired token', async () => {
    service.findActiveFamilyId.mockResolvedValueOnce(null);
    const response = await post('expired-token').expect(204);

    expect(service.revokeFamily).not.toHaveBeenCalled();
    clearedCookies(response);
  });

  it('returns 403 without revoking or clearing when CSRF is missing', async () => {
    const response = await post(TOKEN, '').expect(403);

    expect(service.findActiveFamilyId).toHaveBeenCalledWith(TOKEN);
    expect(service.revokeFamily).not.toHaveBeenCalled();
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('returns 403 without revoking or clearing when CSRF is invalid', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Origin', ORIGIN)
      .set('Cookie', `${REFRESH_SESSION_COOKIE}=${TOKEN}; ${REFRESH_CSRF_COOKIE}=${CSRF}`)
      .set('x-csrf-token', 'wrong-csrf')
      .expect(403);

    expect(service.revokeFamily).not.toHaveBeenCalled();
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('returns 403 without revoking when CSRF belongs to another session', async () => {
    service.csrfBindingMatches.mockResolvedValueOnce(false);
    const response = await post(TOKEN).expect(403);

    expect(service.csrfBindingMatches).toHaveBeenCalledWith(TOKEN, CSRF);
    expect(service.revokeFamily).not.toHaveBeenCalled();
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('leaves another user family unaffected', async () => {
    service.findActiveFamilyId.mockImplementation(async (token: string) =>
      token === TOKEN ? 'family-A' : 'family-B',
    );

    await post(TOKEN).expect(204);

    expect(service.revokeFamily).toHaveBeenCalledTimes(1);
    expect(service.revokeFamily).toHaveBeenCalledWith('family-A', 'logout');
    expect(service.revokeFamily).not.toHaveBeenCalledWith('family-B', 'logout');
  });

  it('reuses Origin validation and rejects unconfigured origins', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Origin', 'https://attacker.example.com')
      .set('Cookie', `${REFRESH_SESSION_COOKIE}=${TOKEN}; ${REFRESH_CSRF_COOKIE}=${CSRF}`)
      .set('x-csrf-token', CSRF)
      .expect(403);

    expect(service.findActiveFamilyId).not.toHaveBeenCalled();
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});
