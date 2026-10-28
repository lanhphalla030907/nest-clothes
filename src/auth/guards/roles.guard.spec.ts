import {
  Controller,
  ForbiddenException,
  Get,
  HttpStatus,
  UnauthorizedException,
  UseGuards,
  ValidationPipe,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TestIdentityRegistry } from '../../../test/support/auth-fixtures.js';
import { Role } from '../../generated/prisma/enums.js';
import { UsersRepository } from '../../users/repositories/users.repository.js';
import { Roles } from '../decorators/roles.decorator.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { FORBIDDEN_MESSAGE, RolesGuard } from './roles.guard.js';

@Controller('probe')
@UseGuards(JwtAuthGuard, RolesGuard)
class RoleProbeController {
  /** Admin-only: `@Roles` narrows this one. */
  @Get('admin-only')
  @Roles(Role.ADMIN)
  adminOnly(): { route: string } {
    return { route: 'admin-only' };
  }

  /** Customer-only. */
  @Get('customer-only')
  @Roles(Role.CUSTOMER)
  customerOnly(): { route: string } {
    return { route: 'customer-only' };
  }

  /** Either of the two, to prove the decorator reads a set. */
  @Get('either')
  @Roles(Role.ADMIN, Role.CUSTOMER)
  either(): { route: string } {
    return { route: 'either' };
  }

  /** No `@Roles` at all: authenticated is the only requirement. */
  @Get('any-authenticated')
  anyAuthenticated(): { route: string } {
    return { route: 'any-authenticated' };
  }
}

const CUSTOMER_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const ADMIN_ID = 'b2c3d4e5-f6a7-4b81-9c0d-1e2f3a4b5c6d';

/**
 * Authorization is the second half of the boundary, and the part a bug in is easiest to
 * miss: authentication answers "who is this", authorization answers "may they". These
 * tests pin the distinction between the two failures — 401 when there is no proven
 * identity, 403 when there is one that lacks the role — because collapsing them either
 * hides a broken login or asks an unauthenticated caller to prove they are a customer.
 */
describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: { getAllAndOverride: ReturnType<typeof vi.fn> };

  const contextFor = (user: unknown) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => ({}),
      getClass: () => RoleProbeController,
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    reflector = { getAllAndOverride: vi.fn() };
    guard = new RolesGuard(reflector as never);
  });

  it('allows a caller holding one of the required roles', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN]);

    expect(
      guard.canActivate(contextFor({ id: CUSTOMER_ID, role: Role.ADMIN })),
    ).toBe(true);
  });

  it('reads the requirement as a set, so any one role is enough', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN, Role.CUSTOMER]);

    expect(
      guard.canActivate(contextFor({ id: CUSTOMER_ID, role: Role.CUSTOMER })),
    ).toBe(true);
  });

  it('refuses an authenticated caller without the role, with 403', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN]);

    expect(() =>
      guard.canActivate(contextFor({ id: CUSTOMER_ID, role: Role.CUSTOMER })),
    ).toThrow(ForbiddenException);
    expect(() =>
      guard.canActivate(contextFor({ id: CUSTOMER_ID, role: Role.CUSTOMER })),
    ).toThrow(FORBIDDEN_MESSAGE);
  });

  it('answers 401, not 403, when nobody is authenticated', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN]);

    expect(() => guard.canActivate(contextFor(undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it('allows any authenticated caller when the route states no roles', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    expect(
      guard.canActivate(contextFor({ id: CUSTOMER_ID, role: Role.CUSTOMER })),
    ).toBe(true);
  });
});

describe('RolesGuard (HTTP)', () => {
  let app: INestApplication;
  let identities: TestIdentityRegistry;
  let base: string;

  beforeAll(async () => {
    identities = new TestIdentityRegistry();
    identities.register({
      id: CUSTOMER_ID,
      email: 'ada@example.test',
      role: Role.CUSTOMER,
    });
    identities.register({
      id: ADMIN_ID,
      email: 'root@example.test',
      role: Role.ADMIN,
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RoleProbeController],
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

  const get = (path: string, userId?: string) =>
    fetch(`${base}${path}`, {
      headers: userId === undefined ? {} : identities.bearerHeaderFor(userId),
    });

  it('lets an admin through an admin-only route', async () => {
    const res = await get('/probe/admin-only', ADMIN_ID);

    expect(res.status).toBe(HttpStatus.OK);
  });

  it('refuses a customer on an admin-only route with 403', async () => {
    const res = await get('/probe/admin-only', CUSTOMER_ID);

    expect(res.status).toBe(HttpStatus.FORBIDDEN);
  });

  it('answers 401 rather than 403 when there is no token at all', async () => {
    const res = await get('/probe/admin-only');

    expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('refuses an admin on a customer-only route', async () => {
    const res = await get('/probe/customer-only', ADMIN_ID);

    expect(res.status).toBe(HttpStatus.FORBIDDEN);
  });

  it('lets either role through a route that allows either', async () => {
    await expect(get('/probe/either', CUSTOMER_ID)).resolves.toMatchObject({
      status: HttpStatus.OK,
    });
    await expect(get('/probe/either', ADMIN_ID)).resolves.toMatchObject({
      status: HttpStatus.OK,
    });
  });

  it('requires only authentication where no role is named', async () => {
    await expect(
      get('/probe/any-authenticated', CUSTOMER_ID),
    ).resolves.toMatchObject({ status: HttpStatus.OK });
    await expect(
      get('/probe/any-authenticated'),
    ).resolves.toMatchObject({ status: HttpStatus.UNAUTHORIZED });
  });
});