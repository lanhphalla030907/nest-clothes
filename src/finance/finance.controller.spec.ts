import 'reflect-metadata';
import {
  BadRequestException,
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TestIdentityRegistry } from '../../test/support/auth-fixtures.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Role } from '../generated/prisma/enums.js';
import { FinanceController } from './finance.controller.js';
import { FinanceService } from './finance.service.js';

const ADMIN_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const CUSTOMER_ID = 'b2c3d4e5-f6a7-4b81-9c0d-1e2f3a4b5c6d';
const STAFF_ID = 'c3d4e5f6-a7b8-4c92-8d1e-2f3a4b5c6d7e';

const rangeResponse = {
  from: '2026-09-01',
  to: '2026-09-30',
  basis: 'delivered',
  timezone: 'Asia/Phnom_Penh',
};

const responses = {
  getOverview: {
    range: rangeResponse,
    byCurrency: [],
    cashByCurrency: [],
  },
  getRevenueTrend: {
    range: rangeResponse,
    granularity: 'day',
    timezone: 'Asia/Phnom_Penh',
    series: [],
  },
  getProductProfitability: {
    range: rangeResponse,
    items: [],
    pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
  },
  getRankings: {
    range: rangeResponse,
    metric: 'revenue',
    items: [],
  },
  getCashReconciliation: {
    range: rangeResponse,
    byCurrency: [],
  },
};

type FinanceServiceMethod = keyof typeof responses;

const endpoints: Array<{
  path: string;
  method: FinanceServiceMethod;
}> = [
  { path: '/admin/finance/overview', method: 'getOverview' },
  { path: '/admin/finance/revenue-trend', method: 'getRevenueTrend' },
  { path: '/admin/finance/products', method: 'getProductProfitability' },
  { path: '/admin/finance/rankings', method: 'getRankings' },
  {
    path: '/admin/finance/cash-reconciliation',
    method: 'getCashReconciliation',
  },
];

function makeService() {
  return {
    getOverview: vi.fn().mockResolvedValue(responses.getOverview),
    getRevenueTrend: vi.fn().mockResolvedValue(responses.getRevenueTrend),
    getProductProfitability: vi
      .fn()
      .mockResolvedValue(responses.getProductProfitability),
    getRankings: vi.fn().mockResolvedValue(responses.getRankings),
    getCashReconciliation: vi
      .fn()
      .mockResolvedValue(responses.getCashReconciliation),
  };
}

describe('FinanceController authorization', () => {
  it('requires JWT authentication followed by the ADMIN role guard', () => {
    expect(Reflect.getMetadata('__guards__', FinanceController)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, FinanceController)).toEqual([
      Role.ADMIN,
    ]);
  });
});

describe('FinanceController (HTTP)', () => {
  let app: INestApplication;
  let base: string;
  let identities: TestIdentityRegistry;
  let service: ReturnType<typeof makeService>;

  beforeAll(async () => {
    identities = new TestIdentityRegistry();
    identities.register({
      id: ADMIN_ID,
      email: 'finance-admin@example.test',
      role: Role.ADMIN,
    });
    identities.register({
      id: CUSTOMER_ID,
      email: 'finance-customer@example.test',
      role: Role.CUSTOMER,
    });
    identities.register({
      id: STAFF_ID,
      email: 'finance-staff@example.test',
      role: Role.DELIVERY_STAFF,
    });

    service = makeService();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FinanceController],
      providers: [
        ...identities.providers(),
        { provide: FinanceService, useValue: service },
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

  const get = (path: string, userId?: string) =>
    fetch(`${base}${path}`, {
      headers: userId === undefined ? {} : identities.bearerHeaderFor(userId),
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

  it('refuses delivery staff, who are not finance administrators', async () => {
    const res = await get('/admin/finance/overview', STAFF_ID);

    expect(res.status).toBe(HttpStatus.FORBIDDEN);
    expect(service.getOverview).not.toHaveBeenCalled();
  });

  it('refuses a token whose ADMIN claim disagrees with the database role', async () => {
    const forged = identities.sign({
      id: CUSTOMER_ID,
      email: 'finance-customer@example.test',
      role: Role.ADMIN,
    });

    const res = await fetch(`${base}/admin/finance/overview`, {
      headers: { Authorization: `Bearer ${forged}` },
    });

    expect(res.status).toBe(HttpStatus.FORBIDDEN);
    expect(service.getOverview).not.toHaveBeenCalled();
  });

  it('forwards normalised date, currency and basis filters', async () => {
    const res = await get(
      '/admin/finance/overview?from=2026-09-01&to=2026-09-30&currency=usd&basis=BOOKED',
      ADMIN_ID,
    );

    expect(res.status).toBe(HttpStatus.OK);
    expect(service.getOverview).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '2026-09-01',
        to: '2026-09-30',
        currency: 'USD',
        basis: 'booked',
      }),
    );
  });

  it('forwards product pagination and sorting', async () => {
    const res = await get(
      '/admin/finance/products?page=2&limit=50&sortBy=profit&sortOrder=asc&currency=KHR',
      ADMIN_ID,
    );

    expect(res.status).toBe(HttpStatus.OK);
    expect(service.getProductProfitability).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 2,
        limit: 50,
        sortBy: 'profit',
        sortOrder: 'asc',
        currency: 'KHR',
      }),
    );
  });

  it('forwards trend granularity and ranking metric', async () => {
    await get('/admin/finance/revenue-trend?granularity=MONTH', ADMIN_ID);
    await get('/admin/finance/rankings?metric=profit&limit=5', ADMIN_ID);

    expect(service.getRevenueTrend).toHaveBeenCalledWith(
      expect.objectContaining({ granularity: 'month' }),
    );
    expect(service.getRankings).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'profit', limit: 5 }),
    );
  });

  it('rejects cash-reconciliation basis because cash is measured by event time', async () => {
    const res = await get(
      '/admin/finance/cash-reconciliation?basis=booked',
      ADMIN_ID,
    );

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.getCashReconciliation).not.toHaveBeenCalled();
  });

  it.each([
    '/admin/finance/overview?from=2026-2-31',
    '/admin/finance/overview?currency=US',
    '/admin/finance/overview?basis=accrual',
    '/admin/finance/overview?unknown=value',
    '/admin/finance/products?page=0',
    '/admin/finance/products?page=1.5',
    '/admin/finance/products?limit=101',
    '/admin/finance/products?sortBy=sku',
    '/admin/finance/products?sortOrder=sideways',
    '/admin/finance/revenue-trend?granularity=yearly',
    '/admin/finance/rankings?metric=margin',
    '/admin/finance/rankings?limit=51',
  ])('rejects invalid query %s with 400', async (path) => {
    const res = await get(path, ADMIN_ID);

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    for (const method of Object.values(service)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it('propagates a service error from an endpoint', async () => {
    service.getOverview.mockRejectedValueOnce(
      new BadRequestException('from must not be after to'),
    );

    const res = await get('/admin/finance/overview', ADMIN_ID);

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.getOverview).toHaveBeenCalledOnce();
  });
});
