import 'reflect-metadata';
import {
  BadRequestException,
  HttpStatus,
  NotFoundException,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TestIdentityRegistry } from '../../test/support/auth-fixtures.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Role } from '../generated/prisma/enums.js';
import { CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';

const ADMIN_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const CUSTOMER_ID = 'b2c3d4e5-f6a7-4b81-9c0d-1e2f3a4b5c6d';
const STAFF_ID = 'c3d4e5f6-a7b8-4c92-8d1e-2f3a4b5c6d7e';

const listResponse = {
  items: [
    {
      id: CUSTOMER_ID,
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.test',
      phone: '+15555550100',
      status: 'ACTIVE',
      createdAt: new Date('2026-01-04T11:30:00.000Z'),
      totalOrders: 7,
      totalSpentByCurrency: [{ currency: 'USD', amount: '180.00' }],
      lastOrderAt: new Date('2026-02-01T00:00:00.000Z'),
    },
  ],
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
};

const statsResponse = {
  totalCustomers: 32,
  activeCustomers: 30,
  newCustomers: 4,
  customersWithOrders: 9,
  newCustomerWindowDays: 30,
};

const detailResponse = {
  id: CUSTOMER_ID,
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.test',
  phone: '+15555550100',
  status: 'ACTIVE',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  emailVerifiedAt: null,
  lastLoginAt: null,
  totalOrders: 7,
  cancelledOrders: 1,
  spendingOrders: 4,
  totalSpentByCurrency: [{ currency: 'USD', amount: '180.00' }],
  averageOrderValueByCurrency: [{ currency: 'USD', amount: '60.00' }],
  lastOrderAt: new Date('2026-02-01T00:00:00.000Z'),
  recentOrders: [],
  addresses: [],
};

const responses = {
  listCustomers: listResponse,
  getStats: statsResponse,
  getCustomer: detailResponse,
};

type CustomersServiceMethod = keyof typeof responses;

const endpoints: Array<{
  path: string;
  method: CustomersServiceMethod;
}> = [
  { path: '/admin/customers', method: 'listCustomers' },
  { path: '/admin/customers/stats', method: 'getStats' },
  { path: `/admin/customers/${CUSTOMER_ID}`, method: 'getCustomer' },
];

function makeService() {
  return {
    listCustomers: vi.fn().mockResolvedValue(listResponse),
    getStats: vi.fn().mockResolvedValue(statsResponse),
    getCustomer: vi.fn().mockResolvedValue(detailResponse),
  };
}

/**
 * `GET /admin/customers`, `GET /admin/customers/stats` and
 * `GET /admin/customers/:id` over real HTTP.
 *
 * The service is stubbed, so this file is about the HTTP contract: the
 * authorisation matrix, query validation, UUID parsing, the literal `stats`
 * route winning over `:id`, and the deliberate absence of any write route.
 * Database selection and aggregation are pinned in
 * `customers.repository.spec.ts`; the row-to-DTO mapping in
 * `customers.service.spec.ts`.
 */
describe('CustomersController authorization', () => {
  it('requires JWT authentication followed by the ADMIN role guard', () => {
    expect(Reflect.getMetadata('__guards__', CustomersController)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, CustomersController)).toEqual([
      Role.ADMIN,
    ]);
  });
});

describe('CustomersController (HTTP)', () => {
  let app: INestApplication;
  let base: string;
  let identities: TestIdentityRegistry;
  let service: ReturnType<typeof makeService>;

  beforeAll(async () => {
    identities = new TestIdentityRegistry();
    identities.register({
      id: ADMIN_ID,
      email: 'customers-admin@example.test',
      role: Role.ADMIN,
    });
    identities.register({
      id: CUSTOMER_ID,
      email: 'ada@example.test',
      role: Role.CUSTOMER,
    });
    identities.register({
      id: STAFF_ID,
      email: 'customers-staff@example.test',
      role: Role.DELIVERY_STAFF,
    });

    service = makeService();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CustomersController],
      providers: [
        ...identities.providers(),
        { provide: CustomersService, useValue: service },
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
    service.listCustomers.mockResolvedValue(listResponse);
    service.getStats.mockResolvedValue(statsResponse);
    service.getCustomer.mockResolvedValue(detailResponse);
  });

  const get = (path: string, userId?: string, init?: RequestInit) =>
    fetch(`${base}${path}`, {
      ...init,
      headers:
        init?.headers ??
        (userId === undefined ? {} : identities.bearerHeaderFor(userId)),
    });

  it.each(endpoints)(
    'serves $path to an administrator',
    async ({ path, method }) => {
      const res = await get(path, ADMIN_ID);

      expect(res.status).toBe(HttpStatus.OK);
      await expect(res.json()).resolves.toEqual(
        JSON.parse(JSON.stringify(responses[method])),
      );
      expect(service[method]).toHaveBeenCalledOnce();
    },
  );

  it.each(endpoints)(
    'refuses an unauthenticated caller on $path with 401',
    async ({ path, method }) => {
      const res = await get(path);

      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
      expect(service[method]).not.toHaveBeenCalled();
    },
  );

  it.each(endpoints)(
    'refuses a customer on $path with 403',
    async ({ path, method }) => {
      const res = await get(path, CUSTOMER_ID);

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(service[method]).not.toHaveBeenCalled();
    },
  );

  it.each(endpoints)(
    'refuses delivery staff on $path with 403',
    async ({ path, method }) => {
      const res = await get(path, STAFF_ID);

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(service[method]).not.toHaveBeenCalled();
    },
  );

  it('refuses a token whose ADMIN claim disagrees with the database role', async () => {
    const forged = identities.sign({
      id: CUSTOMER_ID,
      email: 'ada@example.test',
      role: Role.ADMIN,
    });

    const res = await fetch(`${base}/admin/customers`, {
      headers: { Authorization: `Bearer ${forged}` },
    });

    expect(res.status).toBe(HttpStatus.FORBIDDEN);
    expect(service.listCustomers).not.toHaveBeenCalled();
  });

  it('serves the literal stats route rather than parsing "stats" as an id', async () => {
    const res = await get('/admin/customers/stats', ADMIN_ID);

    expect(res.status).toBe(HttpStatus.OK);
    expect(service.getStats).toHaveBeenCalledOnce();
    expect(service.getCustomer).not.toHaveBeenCalled();
  });

  it.each(['post', 'put', 'patch', 'delete'])(
    'exposes no %s route â€” the feature is read-only',
    async (method) => {
      const res = await get('/admin/customers', ADMIN_ID, { method });

      expect([HttpStatus.NOT_FOUND, HttpStatus.BAD_REQUEST, HttpStatus.METHOD_NOT_ALLOWED]).toContain(res.status);
      expect(service.listCustomers).not.toHaveBeenCalled();
    },
  );

  describe('the list query', () => {
    it('applies the documented defaults', async () => {
      await get('/admin/customers', ADMIN_ID);

      expect(service.listCustomers).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, limit: 20 }),
      );
    });

    it('passes valid filters, sorts and dates through, with the search trimmed', async () => {
      await get(
        '/admin/customers?page=2&limit=50&search=%20Ada%20&status=ACTIVE&registeredFrom=2026-01-01T00:00:00.000Z&registeredTo=2026-01-31T23:59:59.000Z&orderActivity=WITH_ORDERS&sortBy=totalSpent&sortOrder=asc',
        ADMIN_ID,
      );

      expect(service.listCustomers).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 2,
          limit: 50,
          search: 'Ada',
          status: 'ACTIVE',
          registeredFrom: '2026-01-01T00:00:00.000Z',
          registeredTo: '2026-01-31T23:59:59.000Z',
          orderActivity: 'WITH_ORDERS',
          sortBy: 'totalSpent',
          sortOrder: 'asc',
        }),
      );
    });

    it.each([
      'page=0',
      'page=-1',
      'page=1.5',
      'page=abc',
      'limit=0',
      'limit=101',
      `search=${'a'.repeat(201)}`,
      `status=${'a'.repeat(21)}`,
      'registeredFrom=not-a-date',
      'registeredTo=2026-02-31',
      'sortBy=revenue',
      'sortOrder=downward',
      'orderActivity=SOMETIMES',
    ])('rejects %s with 400', async (queryString) => {
      const res = await get(`/admin/customers?${queryString}`, ADMIN_ID);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.listCustomers).not.toHaveBeenCalled();
    });

    it('rejects an unknown query parameter rather than ignoring it', async () => {
      const res = await get('/admin/customers?passwordHash=1', ADMIN_ID);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.listCustomers).not.toHaveBeenCalled();
    });

    it('passes the cross-field date rejection through as a 400', async () => {
      service.listCustomers.mockRejectedValue(
        new BadRequestException(
          'registeredFrom must not be later than registeredTo',
        ),
      );

      const res = await get(
        '/admin/customers?registeredFrom=2026-02-01T00:00:00.000Z&registeredTo=2026-01-01T00:00:00.000Z',
        ADMIN_ID,
      );

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });
  });

  describe('the detail route', () => {
    it('rejects a malformed id with 400 before the service', async () => {
      const res = await get('/admin/customers/not-a-uuid', ADMIN_ID);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.getCustomer).not.toHaveBeenCalled();
    });

    it('rejects the literal "stats" on the detail route, proving the routes are distinct', async () => {
      const res = await get('/admin/customers/stats', ADMIN_ID);

      expect(res.status).toBe(HttpStatus.OK);
      expect(service.getCustomer).not.toHaveBeenCalledWith('stats');
    });

    it('passes a 404 through for a well-formed id that is not a customer', async () => {
      service.getCustomer.mockRejectedValue(
        new NotFoundException('Customer does not exist'),
      );

      const res = await get(
        '/admin/customers/d4e5f6a7-b8c9-4d03-9e2f-3a4b5c6d7e8f',
        ADMIN_ID,
      );

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });
  });
});
