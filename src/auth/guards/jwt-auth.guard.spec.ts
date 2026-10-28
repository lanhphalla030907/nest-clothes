import {
  Controller,
  Get,
  HttpStatus,
  UnauthorizedException,
  UseGuards,
  ValidationPipe,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import {
  TEST_JWT_SETTINGS,
  TestIdentityRegistry,
  signRawToken,
} from '../../../test/support/auth-fixtures.js';
import { Role } from '../../generated/prisma/enums.js';
import { UsersRepository } from '../../users/repositories/users.repository.js';
import type { AuthenticatedRequest } from '../types/authenticated-request.js';
import { CurrentUser } from '../decorators/current-user.decorator.js';
import { AccessTokenService } from '../jwt/access-token.service.js';
import { JwtAuthGuard, UNAUTHENTICATED_MESSAGE } from './jwt-auth.guard.js';

/** A minimal controller that mounts the guard, for the HTTP-level tests. */
@Controller('probe')
@UseGuards(JwtAuthGuard)
class ProbeController {
  @Get('whoami')
  whoami(@CurrentUser() user: AuthenticatedRequest['user']): {
    id: string;
    email: string;
    role: string;
  } {
    return { id: user?.id ?? '', email: user?.email ?? '', role: user?.role ?? '' };
  }
}

const USER_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const ADMIN_ID = 'b2c3d4e5-f6a7-4b81-9c0d-1e2f3a4b5c6d';
const UNKNOWN_USER_ID = 'c3d4e5f6-a7b8-4c92-8d1e-2f3a4b5c6d7e';

/**
 * `JwtAuthGuard` is the whole security boundary of every user-owned route, so these
 * tests are about what it refuses rather than what it allows.
 *
 * Everything runs against the real signing and verification path — a guard test with a
 * mocked `AccessTokenService` would pass while the verification was broken, since the
 * mock would return claims for any input.
 */
describe('JwtAuthGuard', () => {
  let identities: TestIdentityRegistry;
  let guard: JwtAuthGuard;
  let findById: ReturnType<typeof vi.fn>;

  /**
   * An `ExecutionContext` whose request carries `headers`.
   *
   * Keys are lowercased here because Node does that to every incoming header before
   * Express sees it, and the guard reads `headers['authorization']` accordingly. Without
   * it these unit tests would pass a header the real server could never send.
   */
  const probe = (headers: Record<string, string>) => {
    const lowercased = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
    const request = { headers: lowercased } as AuthenticatedRequest;

    return {
      context: {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext,
      request,
    };
  };

  /** Just the context, for the cases where nothing needs to inspect the request. */
  const contextFor = (headers: Record<string, string>) => probe(headers).context;

  beforeEach(() => {
    identities = new TestIdentityRegistry();
    identities.register({ id: USER_ID, email: 'ada@example.test', role: Role.CUSTOMER });
    identities.register({
      id: ADMIN_ID,
      email: 'root@example.test',
      role: Role.ADMIN,
    });

    findById = vi.fn(identities.findById().findById);
    guard = new JwtAuthGuard(
      new AccessTokenService(
        new JwtService({}),
        TEST_JWT_SETTINGS,
      ),
      { findById } as unknown as UsersRepository,
    );
  });

  it('accepts a valid token and attaches the identity', async () => {
    const { context, request } = probe(identities.bearerHeaderFor(USER_ID));

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({
      id: USER_ID,
      email: 'ada@example.test',
      role: Role.CUSTOMER,
    });
  });

  it('takes the role from the database row, never from the token claims', async () => {
    // A token whose `role` claim says ADMIN, signed with the real key, for a user the
    // database still has as CUSTOMER. If the guard trusted the claim this would attach
    // ADMIN and reach an admin-only route.
    const forged = signRawToken({
      sub: USER_ID,
      email: 'ada@example.test',
      role: Role.ADMIN,
    });

    const { context, request } = probe({ Authorization: `Bearer ${forged}` });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user?.role).toBe(Role.CUSTOMER);
  });

  it('refuses a user the database says is not active', async () => {
    identities.register(
      { id: ADMIN_ID, email: 'root@example.test', role: Role.ADMIN },
      { status: 'SUSPENDED' },
    );

    await expect(
      guard.canActivate(contextFor(identities.bearerHeaderFor(ADMIN_ID))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a token whose subject is not in the database', async () => {
    await expect(
      guard.canActivate(contextFor(identities.bearerHeaderFor(UNKNOWN_USER_ID))),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(findById).toHaveBeenCalledWith(UNKNOWN_USER_ID);
  });

  it('refuses a request with no Authorization header', async () => {
    await expect(guard.canActivate(contextFor({}))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(findById).not.toHaveBeenCalled();
  });

  it('refuses the retired X-User-Id header even when it names a real user', async () => {
    await expect(
      guard.canActivate(contextFor({ 'X-User-Id': USER_ID })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(findById).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty bearer', 'Bearer '],
    ['a bare token', 'abc.def.ghi'],
    ['another scheme', 'Basic dXNlcjpwYXNz'],
    ['a token with no scheme', 'just-a-token'],
  ])('refuses %s', async (_name, header) => {
    await expect(
      guard.canActivate(contextFor({ Authorization: header })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts the scheme case-insensitively, as the RFC allows', async () => {
    const { context } = probe({
      Authorization: `bearer ${identities.bearerFor(USER_ID)}`,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('refuses an expired token', async () => {
    await expect(
      guard.canActivate(
        contextFor({
          Authorization: `Bearer ${identities.signExpired({
            id: USER_ID,
            email: 'ada@example.test',
            role: Role.CUSTOMER,
          })}`,
        }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a token signed with another key', async () => {
    await expect(
      guard.canActivate(
        contextFor({
          Authorization: `Bearer ${identities.signWithForeignKey({
            id: USER_ID,
            email: 'ada@example.test',
            role: Role.CUSTOMER,
          })}`,
        }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a token minted for another audience', async () => {
    const foreign = signRawToken(
      { sub: USER_ID, email: 'ada@example.test', role: Role.CUSTOMER },
      { audience: 'some-other-service' },
    );

    await expect(
      guard.canActivate(contextFor({ Authorization: `Bearer ${foreign}` })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a token minted by another issuer', async () => {
    const foreign = signRawToken(
      { sub: USER_ID, email: 'ada@example.test', role: Role.CUSTOMER },
      { issuer: 'some-other-issuer' },
    );

    await expect(
      guard.canActivate(contextFor({ Authorization: `Bearer ${foreign}` })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a correctly signed token that carries no subject', async () => {
    const subjectless = signRawToken({
      email: 'ada@example.test',
      role: Role.CUSTOMER,
    });

    await expect(
      guard.canActivate(contextFor({ Authorization: `Bearer ${subjectless}` })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(findById).not.toHaveBeenCalled();
  });

  it('answers every refusal with the same opaque message', async () => {
    const attempts: Record<string, string>[] = [
      {},
      { 'X-User-Id': USER_ID },
      { Authorization: 'Bearer not-a-token' },
      { Authorization: `Bearer ${identities.bearerFor(UNKNOWN_USER_ID)}` },
    ];

    const bodies = await Promise.all(
      attempts.map(async (headers) => {
        // `canActivate` rejects for every one of these; `.catch` makes the refusal a value
        // so the four can be compared instead of asserted one at a time.
        const response = await guard
          .canActivate(contextFor(headers))
          .then(() => {
            throw new Error('expected the guard to refuse this request');
          })
          .catch((error: unknown) => error);

        expect(response).toBeInstanceOf(UnauthorizedException);

        return (response as UnauthorizedException).getResponse() as {
          message: string;
        };
      }),
    );

    expect(new Set(bodies.map((body) => body.message)).size).toBe(1);
    expect(bodies[0].message).toBe(UNAUTHENTICATED_MESSAGE);
  });
});

/**
 * The same guard, mounted on a real route, to prove the 401 reaches the client as a 401
 * rather than as an unhandled rejection.
 */
describe('JwtAuthGuard (HTTP)', () => {
  let app: INestApplication;
  let identities: TestIdentityRegistry;
  let base: string;

  beforeAll(async () => {
    identities = new TestIdentityRegistry();
    identities.register({ id: USER_ID, email: 'ada@example.test', role: Role.CUSTOMER });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        ...identities.providers(),
        { provide: UsersRepository, useValue: identities.findById() },
      ],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0);
    base = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  it('passes a verified identity to the controller', async () => {
    const res = await fetch(`${base}/probe/whoami`, {
      headers: identities.bearerHeaderFor(USER_ID),
    });

    expect(res.status).toBe(HttpStatus.OK);
    await expect(res.json()).resolves.toEqual({
      id: USER_ID,
      email: 'ada@example.test',
      role: 'CUSTOMER',
    });
  });

  it.each([
    ['no header', {}],
    ['the retired header', { 'X-User-Id': USER_ID }],
    ['a junk token', { Authorization: 'Bearer junk' }],
    ['an unknown scheme', { Authorization: 'Token abc' }],
  ])('answers 401 for %s', async (_name, headers) => {
    const res = await fetch(`${base}/probe/whoami`, { headers });

    expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    await expect(res.json()).resolves.toMatchObject({
      message: UNAUTHENTICATED_MESSAGE,
    });
  });
});