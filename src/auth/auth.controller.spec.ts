import {
  HttpStatus,
  UnauthorizedException,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TestIdentityRegistry } from '../../test/support/auth-fixtures.js';
import { Role } from '../generated/prisma/enums.js';
import { UserResponseDto } from '../users/dto/user-response.dto.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { LoginResponseDto } from './dto/login-response.dto.js';
import { LoginDto } from './dto/login.dto.js';

const VALID_PASSWORD = 'Str0ng!Passw0rd';
const USER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const buildLoginDto = (): LoginDto =>
  Object.assign(new LoginDto(), {
    email: 'ada.lovelace@example.com',
    password: VALID_PASSWORD,
  });

const buildUserResponse = (): UserResponseDto =>
  Object.assign(new UserResponseDto(), {
    id: USER_ID,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada.lovelace@example.com',
    phone: null,
    status: 'ACTIVE',
    role: Role.CUSTOMER,
    emailVerifiedAt: null,
    lastLoginAt: new Date('2026-02-02T10:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  });

const buildLoginResponse = (): LoginResponseDto =>
  Object.assign(new LoginResponseDto(), {
    accessToken: 'header.payload.signature',
    expiresIn: '15m',
    user: buildUserResponse(),
  });

describe('AuthController', () => {
  let controller: AuthController;
  let authService: { login: ReturnType<typeof vi.fn>; currentUser: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    authService = { login: vi.fn(), currentUser: vi.fn() };
    const identities = new TestIdentityRegistry();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        ...identities.providers(),
        { provide: AuthService, useValue: authService },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates authentication to AuthService and returns its result', async () => {
    const dto = buildLoginDto();
    const expected = buildLoginResponse();
    authService.login.mockResolvedValue(expected);

    await expect(controller.login(dto)).resolves.toBe(expected);
    expect(authService.login).toHaveBeenCalledTimes(1);
    expect(authService.login).toHaveBeenCalledWith(dto);
  });

  it('returns exactly the token, its lifetime and the safe user', async () => {
    authService.login.mockResolvedValue(buildLoginResponse());

    const result = await controller.login(buildLoginDto());

    expect(Object.keys(result).sort()).toEqual(
      ['accessToken', 'expiresIn', 'user'].sort(),
    );
    expect(Object.keys(result.user).sort()).toEqual(
      [
        'createdAt',
        'email',
        'emailVerifiedAt',
        'firstName',
        'id',
        'lastLoginAt',
        'lastName',
        'phone',
        'role',
        'status',
        'updatedAt',
      ].sort(),
    );
  });

  it('never returns passwordHash or the supplied password', async () => {
    authService.login.mockResolvedValue(buildLoginResponse());

    const result = await controller.login(buildLoginDto());

    expect(Object.keys(result.user)).not.toContain('passwordHash');
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('passwordHash');
    expect(serialised).not.toContain(VALID_PASSWORD);
  });

  it('never returns the signing secret or any JWT setting', async () => {
    authService.login.mockResolvedValue(buildLoginResponse());

    const serialised = JSON.stringify(await controller.login(buildLoginDto()));

    expect(serialised).not.toContain('secret');
    expect(serialised).not.toContain('issuer');
    expect(serialised).not.toContain('algorithm');
  });

  it('propagates authentication failures to the exception layer', async () => {
    authService.login.mockRejectedValue(
      new UnauthorizedException('Invalid email or password'),
    );

    await expect(controller.login(buildLoginDto())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('asks for the authenticated caller, never one named in the request', async () => {
    authService.currentUser.mockResolvedValue(buildUserResponse());

    await expect(
      controller.currentUser({
        id: USER_ID,
        email: 'ada.lovelace@example.com',
        role: Role.CUSTOMER,
      }),
    ).resolves.toMatchObject({ id: USER_ID });

    expect(authService.currentUser).toHaveBeenCalledWith(USER_ID);
  });
});

/**
 * HTTP-level tests.
 *
 * `GET /auth/me` is mounted behind the real `JwtAuthGuard`, so these prove the route is
 * genuinely closed rather than merely decorated — a missing, unusable or unverifiable
 * token has to be a 401, and only a token naming a real, active user reaches the
 * service. The service is mocked, so nothing here touches a database.
 */
describe('AuthController (HTTP)', () => {
  let app: INestApplication;
  let authService: { login: ReturnType<typeof vi.fn>; currentUser: ReturnType<typeof vi.fn> };
  let identities: TestIdentityRegistry;
  let base: string;

  beforeAll(async () => {
    authService = {
      login: vi.fn().mockResolvedValue(buildLoginResponse()),
      currentUser: vi.fn().mockResolvedValue(buildUserResponse()),
    };
    identities = new TestIdentityRegistry();
    identities.register({
      id: USER_ID,
      email: 'ada.lovelace@example.com',
      role: Role.CUSTOMER,
    });
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        ...identities.providers(),
        { provide: AuthService, useValue: authService },
      ],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0);
    base = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers 200 with a token on a valid login', async () => {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'ada.lovelace@example.com',
        password: VALID_PASSWORD,
      }),
    });

    expect(res.status).toBe(HttpStatus.OK);
    await expect(res.json()).resolves.toMatchObject({
      accessToken: 'header.payload.signature',
      expiresIn: '15m',
    });
  });

  it('answers 401 for wrong credentials', async () => {
    authService.login.mockRejectedValue(
      new UnauthorizedException('Invalid email or password'),
    );

    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'ada.lovelace@example.com',
        password: 'wrong',
      }),
    });

    expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('GET /auth/me returns the caller for a valid token', async () => {
    const res = await fetch(`${base}/auth/me`, {
      headers: identities.bearerHeaderFor(USER_ID),
    });

    expect(res.status).toBe(HttpStatus.OK);
    await expect(res.json()).resolves.toMatchObject({ id: USER_ID, role: 'CUSTOMER' });
    expect(authService.currentUser).toHaveBeenCalledWith(USER_ID);
  });

  it('GET /auth/me looks the caller up by the token subject only', async () => {
    // The response is produced by the service from a user id, and the only user id in
    // play is the one the guard resolved from the verified token. Nothing in the
    // request can redirect the lookup — that is asserted by the guard spec, which is
    // where the token-vs-database question belongs.
    const res = await fetch(`${base}/auth/me`, {
      headers: identities.bearerHeaderFor(USER_ID),
    });

    expect(res.status).toBe(HttpStatus.OK);
    expect(authService.currentUser).toHaveBeenCalledTimes(1);
    expect(authService.currentUser).toHaveBeenCalledWith(USER_ID);
  });

  it('GET /auth/me rejects a request with no token', async () => {
    const res = await fetch(`${base}/auth/me`);

    expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(authService.currentUser).not.toHaveBeenCalled();
  });

  it('GET /auth/me rejects the retired X-User-Id header', async () => {
    const res = await fetch(`${base}/auth/me`, {
      headers: { 'X-User-Id': USER_ID },
    });

    expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(authService.currentUser).not.toHaveBeenCalled();
  });

  it('GET /auth/me rejects an expired token', async () => {
    const res = await fetch(`${base}/auth/me`, {
      headers: {
        Authorization: `Bearer ${identities.signExpired({
          id: USER_ID,
          email: 'ada.lovelace@example.com',
          role: Role.CUSTOMER,
        })}`,
      },
    });

    expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(authService.currentUser).not.toHaveBeenCalled();
  });

  it('GET /auth/me rejects a token signed with another key', async () => {
    const res = await fetch(`${base}/auth/me`, {
      headers: {
        Authorization: `Bearer ${identities.signWithForeignKey({
          id: USER_ID,
          email: 'ada.lovelace@example.com',
          role: Role.CUSTOMER,
        })}`,
      },
    });

    expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(authService.currentUser).not.toHaveBeenCalled();
  });

  it('GET /auth/me rejects a non-bearer scheme', async () => {
    const res = await fetch(`${base}/auth/me`, {
      headers: { Authorization: identities.bearerFor(USER_ID) },
    });

    expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(authService.currentUser).not.toHaveBeenCalled();
  });

  it('exposes no route that names a user, so "who am I" cannot become "who is X"', () => {
    const prototype = AuthController.prototype as unknown as Record<string, object>;
    const paths = Object.getOwnPropertyNames(prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => Reflect.getMetadata('path', prototype[name]) as string);

    expect(paths).toEqual(['login', 'me']);
  });
});