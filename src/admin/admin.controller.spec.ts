import {
  ConflictException,
  HttpStatus,
  NotFoundException,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TestIdentityRegistry, signRawToken } from '../../test/support/auth-fixtures.js';
import { Role } from '../generated/prisma/enums.js';
import { UsersRepository } from '../users/repositories/users.repository.js';
import { UsersService } from '../users/users.service.js';
import { AdminController } from './admin.controller.js';

const ADMIN_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const CUSTOMER_ID = 'b2c3d4e5-f6a7-4b81-9c0d-1e2f3a4b5c6d';
const SUBJECT_ID = 'c3d4e5f6-a7b8-4c92-8d1e-2f3a4b5c6d7e';
const UNKNOWN_ID = 'd4e5f6a7-b8c9-4d03-9e2f-3a4b5c6d7e8f';

/**
 * The admin route is where role authorisation becomes observable over HTTP, so these
 * tests are the proof that `@Roles(Role.ADMIN)` means something: a customer is refused
 * with 403, an unauthenticated caller with 401, and only an `ADMIN` reads another
 * user's row.
 *
 * The guard runs the real `UsersRepository` stub, so the role used for the decision is
 * the one in the database — a token claiming ADMIN for a customer would still be
 * refused, and that is asserted here rather than assumed.
 */
describe('AdminController (HTTP)', () => {
  let app: INestApplication;
  let usersService: {
    findOne: ReturnType<typeof vi.fn>;
    createDeliveryStaff: ReturnType<typeof vi.fn>;
  };
  let identities: TestIdentityRegistry;
  let base: string;

  beforeAll(async () => {
    usersService = {
      findOne: vi.fn().mockResolvedValue({
        id: SUBJECT_ID,
        firstName: 'Grace',
        lastName: 'Hopper',
        email: 'grace@example.test',
        phone: null,
        status: 'ACTIVE',
        role: Role.CUSTOMER,
        emailVerifiedAt: null,
        lastLoginAt: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
      createDeliveryStaff: vi.fn().mockResolvedValue({
        id: SUBJECT_ID,
        firstName: 'Grace',
        lastName: 'Hopper',
        email: 'grace@example.test',
        phone: null,
        status: 'ACTIVE',
        role: Role.DELIVERY_STAFF,
        emailVerifiedAt: null,
        lastLoginAt: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    };

    identities = new TestIdentityRegistry();
    identities.register({
      id: ADMIN_ID,
      email: 'root@example.test',
      role: Role.ADMIN,
    });
    identities.register({
      id: CUSTOMER_ID,
      email: 'ada@example.test',
      role: Role.CUSTOMER,
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        ...identities.providers(),
        { provide: UsersRepository, useValue: identities.findById() },
        { provide: UsersService, useValue: usersService },
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

  /**
   * `headers` is the escape hatch: it wins over `userId`, so a test can present a token
   * the registry would never issue for that user.
   */
  const get = (path: string, userId?: string, headers?: Record<string, string>) =>
    fetch(`${base}${path}`, {
      headers:
        headers ?? (userId === undefined ? {} : identities.bearerHeaderFor(userId)),
    });

  const post = (
    path: string,
    body: unknown,
    userId?: string,
  ) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(userId === undefined ? {} : identities.bearerHeaderFor(userId)),
      },
      body: JSON.stringify(body),
    });

  it('lets an admin read any user', async () => {
    const res = await get(`/admin/users/${SUBJECT_ID}`, ADMIN_ID);

    expect(res.status).toBe(HttpStatus.OK);
    expect(usersService.findOne).toHaveBeenCalledWith(SUBJECT_ID);
    await expect(res.json()).resolves.toMatchObject({ id: SUBJECT_ID });
  });

  it('never returns the password hash, even on the admin route', async () => {
    const res = await get(`/admin/users/${SUBJECT_ID}`, ADMIN_ID);

    expect(await res.text()).not.toContain('passwordHash');
  });

  it('refuses a customer with 403', async () => {
    const res = await get(`/admin/users/${SUBJECT_ID}`, CUSTOMER_ID);

    expect(res.status).toBe(HttpStatus.FORBIDDEN);
    expect(usersService.findOne).not.toHaveBeenCalled();
  });

  it('answers 401 with no token, not 403', async () => {
    const res = await get(`/admin/users/${SUBJECT_ID}`);

    expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(usersService.findOne).not.toHaveBeenCalled();
  });

  it('refuses a token whose database role is not ADMIN', async () => {
    // A token claiming ADMIN, correctly signed with the right key, issuer, audience and
    // a long expiry — for a user the database still has as CUSTOMER. Signing it directly
    // rather than going through the registry is what makes the test worth having: the
    // claim is forged, and the database is what settles it.
    identities.register(
      { id: CUSTOMER_ID, email: 'ada@example.test', role: Role.CUSTOMER },
      { role: Role.CUSTOMER },
    );

    const forged = signRawToken({
      sub: CUSTOMER_ID,
      email: 'ada@example.test',
      role: Role.ADMIN,
    });

    const res = await get(`/admin/users/${SUBJECT_ID}`, undefined, {
      Authorization: `Bearer ${forged}`,
    });

    expect(res.status).toBe(HttpStatus.FORBIDDEN);
    expect(usersService.findOne).not.toHaveBeenCalled();
  });

  it('rejects a malformed id with 400 before the service', async () => {
    const res = await get('/admin/users/not-a-uuid', ADMIN_ID);

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(usersService.findOne).not.toHaveBeenCalled();
  });

  it('passes a 404 through for an id that is not a user', async () => {
    usersService.findOne.mockRejectedValue(
      new NotFoundException('User does not exist'),
    );

    const res = await get(`/admin/users/${UNKNOWN_ID}`, ADMIN_ID);

    expect(res.status).toBe(HttpStatus.NOT_FOUND);
  });

  it('lets an admin create delivery staff and never returns authentication data', async () => {
    const body = {
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.test',
      password: 'a-secure-password',
      phone: '+15555550100',
    };

    const res = await post('/admin/users', body, ADMIN_ID);

    expect(res.status).toBe(HttpStatus.CREATED);
    expect(usersService.createDeliveryStaff).toHaveBeenCalledWith(
      expect.objectContaining(body),
    );
    const responseText = await res.text();
    expect(responseText).not.toContain('password');
    expect(responseText).not.toContain('passwordHash');
    expect(JSON.parse(responseText)).toMatchObject({
      id: SUBJECT_ID,
      role: Role.DELIVERY_STAFF,
      status: 'ACTIVE',
    });
  });

  it('refuses non-admin callers from creating delivery staff', async () => {
    const res = await post(
      '/admin/users',
      {
        firstName: 'Grace',
        lastName: 'Hopper',
        email: 'grace@example.test',
        password: 'a-secure-password',
      },
      CUSTOMER_ID,
    );

    expect(res.status).toBe(HttpStatus.FORBIDDEN);
    expect(usersService.createDeliveryStaff).not.toHaveBeenCalled();
  });

  it('requires authentication to create delivery staff', async () => {
    const res = await post('/admin/users', {
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.test',
      password: 'a-secure-password',
    });

    expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(usersService.createDeliveryStaff).not.toHaveBeenCalled();
  });

  it.each([
    ['role', { role: Role.ADMIN }],
    ['status', { status: 'SUSPENDED' }],
  ])('does not accept a client-supplied %s', async (_field, extra) => {
    const res = await post(
      '/admin/users',
      {
        firstName: 'Grace',
        lastName: 'Hopper',
        email: 'grace@example.test',
        password: 'a-secure-password',
        ...extra,
      },
      ADMIN_ID,
    );

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(usersService.createDeliveryStaff).not.toHaveBeenCalled();
  });

  it.each([
    ['missing first name', { firstName: '' }],
    ['invalid email', { email: 'not-an-email' }],
    ['short password', { password: 'short' }],
  ])('rejects invalid create input: %s', async (_case, input) => {
    const res = await post(
      '/admin/users',
      {
        firstName: 'Grace',
        lastName: 'Hopper',
        email: 'grace@example.test',
        password: 'a-secure-password',
        ...input,
      },
      ADMIN_ID,
    );

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(usersService.createDeliveryStaff).not.toHaveBeenCalled();
  });

  it('returns 409 when the email already exists', async () => {
    usersService.createDeliveryStaff.mockRejectedValue(
      new ConflictException('A user with this email already exists'),
    );

    const res = await post(
      '/admin/users',
      {
        firstName: 'Grace',
        lastName: 'Hopper',
        email: 'grace@example.test',
        password: 'a-secure-password',
      },
      ADMIN_ID,
    );

    expect(res.status).toBe(HttpStatus.CONFLICT);
  });

  it('declares user lookup and creation routes', () => {
    expect(Reflect.getMetadata('path', AdminController)).toBe('admin');

    const prototype = AdminController.prototype as unknown as Record<string, object>;
    const routes = Object.getOwnPropertyNames(prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => Reflect.getMetadata('path', prototype[name]) as string);

    expect(routes).toEqual(['users/:id', 'users']);
  });
});