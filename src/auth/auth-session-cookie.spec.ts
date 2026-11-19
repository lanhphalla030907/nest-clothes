import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { TestIdentityRegistry } from '../../test/support/auth-fixtures.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import {
  attachAuthSessionSecrets,
  LoginResponseDto,
} from './dto/login-response.dto.js';
import { PasswordResetService } from './password-reset/password-reset.service.js';
import {
  REFRESH_CSRF_COOKIE,
  REFRESH_SESSION_COOKIE,
} from './refresh/refresh-token.constants.js';

const RAW_REFRESH = 'raw-refresh-secret';
const RAW_CSRF = 'raw-csrf-secret';

const loginResult = (): LoginResponseDto =>
  attachAuthSessionSecrets(
    Object.assign(new LoginResponseDto(), {
      accessToken: 'header.payload.signature',
      expiresIn: '15m',
      user: { id: 'user-1' },
    }),
    {
      rawRefreshToken: RAW_REFRESH,
      rawCsrfToken: RAW_CSRF,
      familyId: 'family-1',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  );

describe('Login session cookies', () => {
  let app: INestApplication;
  let authService: { login: ReturnType<typeof vi.fn>; googleLogin: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    authService = {
      login: vi.fn().mockResolvedValue(loginResult()),
      googleLogin: vi.fn().mockResolvedValue(loginResult()),
    };
    const identities = new TestIdentityRegistry();
    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        ...identities.providers(),
        { provide: AuthService, useValue: authService },
        { provide: PasswordResetService, useValue: {} },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const assertCookies = (response: request.Response): void => {
    const cookies = response.headers['set-cookie'] as string[];
    expect(cookies).toHaveLength(2);
    const refresh = cookies.find((item) => item.startsWith(`${REFRESH_SESSION_COOKIE}=`));
    const csrf = cookies.find((item) => item.startsWith(`${REFRESH_CSRF_COOKIE}=`));
    expect(refresh).toContain(RAW_REFRESH);
    expect(refresh).toContain('HttpOnly');
    expect(csrf).toContain(RAW_CSRF);
    expect(csrf).not.toContain('HttpOnly');
  };

  const assertNoSecretsInJson = (response: request.Response): void => {
    const json = JSON.stringify(response.body);
    expect(json).not.toContain(RAW_REFRESH);
    expect(json).not.toContain(RAW_CSRF);
    expect(Object.keys(response.body).sort()).toEqual([
      'accessToken',
      'expiresIn',
      'user',
    ]);
  };

  it('sets both cookies for email/password login exactly once', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ada@example.com', password: 'Str0ng!Passw0rd' })
      .expect(200);

    expect(authService.login).toHaveBeenCalledTimes(1);
    assertCookies(response);
    assertNoSecretsInJson(response);
  });

  it('sets both cookies for Google login exactly once', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/google')
      .send({ idToken: 'token', nonce: 'nonce' })
      .expect(200);

    expect(authService.googleLogin).toHaveBeenCalledTimes(1);
    assertCookies(response);
    assertNoSecretsInJson(response);
  });

  it('issues no cookies when login fails', async () => {
    authService.login.mockRejectedValueOnce(new UnauthorizedException('bad credentials'));

    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ada@example.com', password: 'wrong' })
      .expect(401);

    expect(response.headers['set-cookie']).toBeUndefined();
  });
});
