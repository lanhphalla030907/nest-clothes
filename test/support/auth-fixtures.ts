import type { Provider } from '@nestjs/common';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { AccessTokenService } from '../../src/auth/jwt/access-token.service.js';
import {
  readJwtSettings,
  type JwtSettings,
} from '../../src/auth/jwt/jwt.config.js';
import { JWT_SETTINGS } from '../../src/auth/jwt/jwt.constants.js';
import type { User } from '../../src/generated/prisma/client.js';
import { Role } from '../../src/generated/prisma/enums.js';
import { UsersRepository } from '../../src/users/repositories/users.repository.js';

/**
 * Test-only authentication helpers.
 *
 * Both kinds of suite here must act as a caller *through the real signing and
 * verification path* — a test that wrote `req.user` by hand, or minted a token with a
 * different key, would pass while the guard was broken:
 *
 * - **Integration suites** (`test/*.e2e-spec.ts`) boot the real application, so they
 *   take the application's own `AccessTokenService` out of the Nest container and sign
 *   with it. The key, issuer, audience and lifetime are the configured ones.
 * - **Controller specs** (`*.controller.spec.ts` under `src/`) mount a single
 *   controller with
 *   a mocked service, so they use {@link TestIdentityRegistry} below: the same real
 *   `AccessTokenService`, the same real `JwtAuthGuard`, and a `UsersRepository` stub
 *   answering from an in-memory map.
 *
 * ## The secret here is a test secret
 *
 * It is a fixed, public string so suites are reproducible. It is **not** a development
 * credential: `.env.example` tells a developer to generate their own, and nothing in
 * `src/` accepts this value. It is written down in exactly one place — this file.
 */
export const TEST_JWT_SECRET =
  'test-only-signing-key-not-a-real-credential-0123456789';

/** The settings the fixtures sign with, resolved through the production validator. */
export const TEST_JWT_SETTINGS: JwtSettings = readJwtSettings({
  JWT_ACCESS_SECRET: TEST_JWT_SECRET,
  JWT_ACCESS_EXPIRES_IN: '15m',
  JWT_ISSUER: 'clothes-ecommerce-api',
  JWT_AUDIENCE: 'clothes-ecommerce-clients',
});

/** A caller a test can present itself as. */
export interface TestIdentity {
  id: string;
  email: string;
  role: Role;
}

/**
 * Signs tokens and resolves them back to users, for suites that mount a controller with
 * no database behind it.
 *
 * The users live in a map here rather than being fetched through `PrismaService`, so a
 * controller spec stays a unit test. `JwtAuthGuard` itself is still exercised for real —
 * signature, expiry, issuer, audience, algorithm, the user lookup and the status check —
 * with only the storage behind the lookup replaced.
 */
export class TestIdentityRegistry {
  private readonly users = new Map<string, User>();

  private readonly accessTokenService: AccessTokenService;

  constructor(settings: JwtSettings = TEST_JWT_SETTINGS) {
    this.accessTokenService = new AccessTokenService(new JwtService({}), settings);
  }

  /**
   * Adds a user the guard will resolve.
   *
   * Defaults to an active `CUSTOMER`, since that is the common case in a controller
   * spec; `overrides` is for the cases that are *about* something else — a suspended
   * account, or an `ADMIN` reaching a role-guarded route.
   */
  register(identity: TestIdentity, overrides: Partial<User> = {}): TestIdentity {
    this.users.set(identity.id, {
      id: identity.id,
      firstName: 'Test',
      lastName: 'Customer',
      email: identity.email,
      passwordHash: '',
      phone: null,
      status: 'ACTIVE',
      role: identity.role,
      emailVerifiedAt: null,
      lastLoginAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    });

    return identity;
  }

  /**
   * The extra providers a controller spec needs for the real guard to run.
   *
   * `JWT_SETTINGS` because `AccessTokenService` injects it, and `UsersRepository`
   * because `JwtAuthGuard` looks the token's subject up through it. Only `findById` is
   * stubbed, deliberately: it is the only method the guard calls, so a later change that
   * starts needing another fails loudly here instead of quietly returning `undefined`.
   */
  providers(): Provider[] {
    return [
      { provide: JWT_SETTINGS, useValue: TEST_JWT_SETTINGS },
      { provide: AccessTokenService, useValue: this.accessTokenService },
      { provide: UsersRepository, useValue: this.findById() },
    ];
  }

  /**
   * A `UsersRepository` stub answering `findById` from this registry.
   *
   * Exposed separately from {@link providers} so a suite that lists `UsersRepository`
   * explicitly — for clarity about what is being replaced — can pass the same stub
   * without the two drifting apart.
   */
  findById(): Pick<UsersRepository, 'findById'> {
    return {
      findById: (id: string) => Promise.resolve(this.users.get(id) ?? null),
    };
  }

  /** A bearer header presenting `identity`. */
  authorizationHeader(identity: TestIdentity): Record<string, string> {
    return { Authorization: `Bearer ${this.sign(identity)}` };
  }

  /**
   * A bearer token for the user id `userId`, registered or not.
   *
   * Convenience for the request helper in a controller spec, where the id is the thing a
   * test is varying. An id that was never registered still gets a well-formed token —
   * which is exactly the case worth testing, since it proves the guard checks the user
   * table rather than believing the token's subject.
   */
  bearerFor(userId: string): string {
    return this.sign({
      id: userId,
      email: `${userId}@example.test`,
      role: Role.CUSTOMER,
    });
  }

  /** An `Authorization` header for the user id `userId`. */
  bearerHeaderFor(userId: string): Record<string, string> {
    return { Authorization: `Bearer ${this.bearerFor(userId)}` };
  }

  /** A valid access token for `identity`. */
  sign(identity: TestIdentity): string {
    return this.accessTokenService.sign(identity);
  }

  /** An already-expired token for `identity`.
   *
   * Signed with the real key, issuer and audience and given a negative lifetime, so the
   * 401 it provokes comes from the guard's expiry handling rather than from a token that
   * was never valid in the first place.
   */
  signExpired(identity: TestIdentity): string {
    return signRawToken(
      { sub: identity.id, email: identity.email, role: identity.role },
      { expiresIn: -60 },
    );
  }

  /**
   * A token signed with a *different* key.
   *
   * For the "a valid-looking token from elsewhere is refused" case: right shape, right
   * claims, right issuer and audience, wrong key.
   */
  signWithForeignKey(identity: TestIdentity): string {
    return signRawToken(
      { sub: identity.id, email: identity.email, role: identity.role },
      { secret: 'a-different-key-that-is-also-long-enough-to-be-accepted' },
    );
  }
}

/**
 * Signs arbitrary claims with the test key.
 *
 * For the tokens a real login would never issue — a wrong audience, a missing subject,
 * an expired lifetime. Kept here so each such test states its *deviation* and nothing
 * else, and so the one unavoidable cast to the library's template-literal duration type
 * lives in a single spot.
 */
export function signRawToken(
  payload: Record<string, unknown>,
  options: {
    secret?: string;
    issuer?: string;
    audience?: string;
    expiresIn?: number | string;
  } = {},
): string {
  return new JwtService({}).sign(payload, {
    secret: options.secret ?? TEST_JWT_SECRET,
    expiresIn: (options.expiresIn ?? TEST_JWT_SETTINGS.expiresIn) as JwtSignOptions['expiresIn'],
    issuer: options.issuer ?? TEST_JWT_SETTINGS.issuer,
    audience: options.audience ?? TEST_JWT_SETTINGS.audience,
    algorithm: 'HS256',
  });
}

/**
 * The real `AccessTokenService`, built directly rather than through Nest.
 *
 * For suites that test the service *below* the container — `AuthService` — where there
 * is no module to ask. It takes no dependency but `JwtService` and the settings, so
 * constructing it here is the same object the application gets.
 */
export function testAccessTokenService(
  settings: JwtSettings = TEST_JWT_SETTINGS,
): AccessTokenService {
  return new AccessTokenService(new JwtService({}), settings);
}

/**
 * Signs with the application's own configured `AccessTokenService`.
 *
 * For integration suites, where the container holds a real one built from the
 * environment. The `App` type is left structural so this helper does not depend on
 * `INestApplication`.
 */
export function accessTokenServiceFrom(app: {
  get: (token: unknown) => AccessTokenService;
}): AccessTokenService {
  return app.get(AccessTokenService);
}