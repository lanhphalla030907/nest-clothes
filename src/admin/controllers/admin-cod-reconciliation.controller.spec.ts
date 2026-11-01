import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  NotFoundException,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { AccessTokenService } from '../../auth/jwt/access-token.service.js';
import { DeliveryService } from '../../delivery/delivery.service.js';
import { AdminCodReconciliationQueryDto } from '../../delivery/dto/admin-cod-reconciliation-query.dto.js';
import { ReconciliationRunHistoryQueryDto } from '../../delivery/dto/reconciliation-run-history-query.dto.js';
import { ReconciliationService } from '../../delivery/reconciliation.service.js';
import { Role } from '../../generated/prisma/enums.js';
import { UsersRepository } from '../../users/repositories/users.repository.js';
import { TestIdentityRegistry } from '../../../test/support/auth-fixtures.js';
import { AdminCodReconciliationController } from './admin-cod-reconciliation.controller.js';

const ADMIN_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const CUSTOMER_ID = 'b2c3d4e5-f6a7-4b81-9c0d-1e2f3a4b5c6d';
const STAFF_ID = 'c3d4e5f6-a7b8-4c92-8d1e-2f3a4b5c6d7e';
const ORDER_ID = 'd4e5f6a7-b8c9-4d03-9e2f-3a4b5c6d7e8f';
const RUN_ID = 'e5f6a7b8-c9d0-4e14-af30-4b5c6d7e8f90';

const reconciliationRun = {
  id: RUN_ID,
  triggerType: 'manual' as const,
  status: 'completed' as const,
  windowStart: new Date('2026-10-15T00:00:00.000Z'),
  windowEnd: new Date('2026-10-16T00:00:00.000Z'),
  processedCount: 1,
  matchedCount: 1,
  discrepancyCount: 0,
  uncollectedCount: 0,
  errorMessage: null,
  startedAt: new Date('2026-10-16T01:00:00.000Z'),
  completedAt: new Date('2026-10-16T01:01:00.000Z'),
  createdAt: new Date('2026-10-16T01:00:00.000Z'),
};

const reconciliationHistory = {
  items: [reconciliationRun],
  page: 1,
  limit: 20,
  total: 1,
  totalPages: 1,
};

const recordsResponse = {
  items: [
    {
      orderId: ORDER_ID,
      orderNumber: 'ORD-1',
      orderStatus: 'DELIVERED',
      paymentMethod: 'COD',
      expectedAmount: '100.00',
      currency: 'USD',
      collectedAmount: '100.00',
      collectionId: 'collection-1',
      collectedAt: null,
      collectedById: STAFF_ID,
      collectedBy: null,
      discrepancy: false,
    },
  ],
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
};

const summaryResponse = {
  totalCollections: 1,
  totalsByCurrency: [
    {
      currency: 'USD',
      collectedAmount: '100.00',
      expectedAmount: '100.00',
      outstandingAmount: '0.00',
      count: 1,
    },
  ],
  expectedAmountByCurrency: [{ currency: 'USD', totalAmount: '100.00' }],
  outstandingAmountByCurrency: [{ currency: 'USD', totalAmount: '0.00' }],
  collectionCount: 1,
  discrepancyCount: 0,
  firstCollectionAt: null,
  lastCollectionAt: null,
  periodBreakdown: [],
  staffBreakdown: [],
};

const uncollectedResponse = {
  items: [
    {
      orderId: ORDER_ID,
      orderNumber: 'ORD-UNCOLLECTED',
      orderStatus: 'DELIVERED',
      expectedAmount: '75.00',
      currency: 'USD',
      deliveryStaffId: STAFF_ID,
      deliveryStaff: null,
      deliveredAt: null,
    },
  ],
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
};

const discrepanciesResponse = {
  items: [
    {
      orderId: ORDER_ID,
      orderNumber: 'ORD-MISSING',
      orderStatus: 'DELIVERED',
      discrepancyType: 'missing-collection',
      expectedAmount: '75.00',
      actualAmount: null,
      currency: 'USD',
      collectionId: null,
    },
  ],
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
};

const staffBreakdownResponse = [
  {
    staffId: STAFF_ID,
    staff: {
      id: STAFF_ID,
      firstName: 'COD',
      lastName: 'Collector',
      email: 'collector@example.test',
    },
    currency: 'USD',
    collectedAmount: '100.00',
    expectedAmount: '100.00',
    outstandingAmount: '0.00',
    count: 1,
  },
];

const periodBreakdownResponse = [
  {
    period: '2026-10-15',
    currency: 'USD',
    collectedAmount: '100.00',
    expectedAmount: '100.00',
    outstandingAmount: '0.00',
    count: 1,
  },
];

const endpoints = [
  [
    '/admin/cod-reconciliation',
    'getCodReconciliationRecords',
    recordsResponse,
  ],
  [
    '/admin/cod-reconciliation/summary',
    'getCodReconciliationSummary',
    summaryResponse,
  ],
  [
    '/admin/cod-reconciliation/uncollected',
    'getUncollectedDeliveredCodOrders',
    uncollectedResponse,
  ],
  [
    '/admin/cod-reconciliation/discrepancies',
    'getCodReconciliationDiscrepancies',
    discrepanciesResponse,
  ],
  [
    '/admin/cod-reconciliation/by-staff',
    'getCodReconciliationByStaff',
    staffBreakdownResponse,
  ],
  [
    '/admin/cod-reconciliation/by-period',
    'getCodReconciliationByPeriod',
    periodBreakdownResponse,
  ],
] as const;

function makeService() {
  return {
    getCodReconciliationRecords: vi.fn(),
    getCodReconciliationSummary: vi.fn(),
    getUncollectedDeliveredCodOrders: vi.fn(),
    getCodReconciliationDiscrepancies: vi.fn(),
    getCodReconciliationByStaff: vi.fn(),
    getCodReconciliationByPeriod: vi.fn(),
  };
}

function makeReconciliationService() {
  return {
    getRunHistory: vi.fn(),
    getRun: vi.fn(),
    triggerManualReconciliation: vi.fn(),
  };
}

function seedServiceResponses(service: ReturnType<typeof makeService>) {
  service.getCodReconciliationRecords.mockResolvedValue(recordsResponse);
  service.getCodReconciliationSummary.mockResolvedValue(summaryResponse);
  service.getUncollectedDeliveredCodOrders.mockResolvedValue(
    uncollectedResponse,
  );
  service.getCodReconciliationDiscrepancies.mockResolvedValue(
    discrepanciesResponse,
  );
  service.getCodReconciliationByStaff.mockResolvedValue(
    staffBreakdownResponse,
  );
  service.getCodReconciliationByPeriod.mockResolvedValue(
    periodBreakdownResponse,
  );
}

function seedReconciliationResponses(
  service: ReturnType<typeof makeReconciliationService>,
) {
  service.getRunHistory.mockResolvedValue(reconciliationHistory);
  service.getRun.mockResolvedValue(reconciliationRun);
  service.triggerManualReconciliation.mockResolvedValue({
    run: reconciliationRun,
    counters: {
      processedCount: 1,
      matchedCount: 1,
      discrepancyCount: 0,
      uncollectedCount: 0,
    },
    discrepancyBreakdown: {
      missingCollections: 0,
      amountMismatches: 0,
      currencyMismatches: 0,
    },
  });
}

describe('AdminCodReconciliationController', () => {
  let controller: AdminCodReconciliationController;
  let service: ReturnType<typeof makeService>;
  let reconciliationService: ReturnType<typeof makeReconciliationService>;

  beforeEach(async () => {
    service = makeService();
    seedServiceResponses(service);
    reconciliationService = makeReconciliationService();
    seedReconciliationResponses(reconciliationService);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminCodReconciliationController],
      providers: [
        { provide: DeliveryService, useValue: service },
        { provide: ReconciliationService, useValue: reconciliationService },
        JwtAuthGuard,
        RolesGuard,
        { provide: AccessTokenService, useValue: { verify: vi.fn() } },
        { provide: UsersRepository, useValue: { findById: vi.fn() } },
      ],
    }).compile();

    controller = module.get(AdminCodReconciliationController);
  });

  it('delegates all six reads to the delivery service', async () => {
    const query = Object.assign(new AdminCodReconciliationQueryDto(), {
      page: 2,
      limit: 5,
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      staffId: STAFF_ID,
      orderId: ORDER_ID,
      orderNumber: 'ORD',
      status: 'DELIVERED',
      currency: 'USD',
      sortBy: 'collectedAt',
      sortOrder: 'asc',
      period: 'daily',
    });

    await expect(controller.findAll(query)).resolves.toBe(recordsResponse);
    await expect(controller.summary(query)).resolves.toBe(summaryResponse);
    await expect(controller.uncollected(query)).resolves.toBe(
      uncollectedResponse,
    );
    await expect(controller.discrepancies(query)).resolves.toBe(
      discrepanciesResponse,
    );
    await expect(controller.byStaff(query)).resolves.toBe(
      staffBreakdownResponse,
    );
    await expect(controller.byPeriod(query)).resolves.toBe(
      periodBreakdownResponse,
    );

    expect(service.getCodReconciliationRecords).toHaveBeenCalledWith(query);
    expect(service.getCodReconciliationSummary).toHaveBeenCalledWith(query);
    expect(service.getUncollectedDeliveredCodOrders).toHaveBeenCalledWith(
      query,
    );
    expect(service.getCodReconciliationDiscrepancies).toHaveBeenCalledWith(
      query,
    );
    expect(service.getCodReconciliationByStaff).toHaveBeenCalledWith(query);
    expect(service.getCodReconciliationByPeriod).toHaveBeenCalledWith(query);
  });

  it('requires JWT authentication followed by the ADMIN role guard', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      AdminCodReconciliationController,
    );

    expect(guards).toEqual([JwtAuthGuard, RolesGuard]);
    expect(
      Reflect.getMetadata(ROLES_KEY, AdminCodReconciliationController),
    ).toEqual([Role.ADMIN]);
  });

  it('delegates run history, detail, and manual trigger requests', async () => {
    const query = Object.assign(new ReconciliationRunHistoryQueryDto(), {
      page: 2,
      limit: 5,
      status: 'completed' as const,
      triggerType: 'manual' as const,
      startDate: '2026-10-01',
      endDate: '2026-10-31',
    });

    await controller.findRuns(query);
    await controller.findRun(RUN_ID);
    await controller.triggerRun({ date: '2026-10-15' });

    expect(reconciliationService.getRunHistory).toHaveBeenCalledWith({
      page: 2,
      limit: 5,
      status: 'completed',
      triggerType: 'manual',
      startDate: new Date('2026-10-01T00:00:00.000Z'),
      endDate: new Date('2026-10-31T23:59:59.999Z'),
    });
    expect(reconciliationService.getRun).toHaveBeenCalledWith(RUN_ID);
    expect(
      reconciliationService.triggerManualReconciliation,
    ).toHaveBeenCalledWith(
      new Date('2026-10-15T00:00:00.000Z'),
      new Date('2026-10-16T00:00:00.000Z'),
    );
  });

  it('does not expose persisted internal failure details in run responses', async () => {
    reconciliationService.getRun.mockResolvedValue({
      ...reconciliationRun,
      status: 'failed',
      errorMessage: 'database connection string and stack trace',
    });

    await expect(controller.findRun(RUN_ID)).resolves.toMatchObject({
      errorMessage: 'Reconciliation failed',
    });
  });
});

describe('AdminCodReconciliationController (HTTP)', () => {
  let app: INestApplication;
  let service: ReturnType<typeof makeService>;
  let reconciliationService: ReturnType<typeof makeReconciliationService>;
  let identities: TestIdentityRegistry;
  let base: string;

  beforeAll(async () => {
    identities = new TestIdentityRegistry();
    identities.register({
      id: ADMIN_ID,
      email: 'root@example.test',
      role: Role.ADMIN,
    });
    identities.register({
      id: CUSTOMER_ID,
      email: 'customer@example.test',
      role: Role.CUSTOMER,
    });

    service = makeService();
    seedServiceResponses(service);
    reconciliationService = makeReconciliationService();
    seedReconciliationResponses(reconciliationService);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminCodReconciliationController],
      providers: [
        ...identities.providers(),
        { provide: DeliveryService, useValue: service },
        { provide: ReconciliationService, useValue: reconciliationService },
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
    vi.resetAllMocks();
    seedServiceResponses(service);
    seedReconciliationResponses(reconciliationService);
  });

  const get = (path: string, userId?: string) =>
    fetch(`${base}${path}`, {
      headers:
        userId === undefined ? {} : identities.bearerHeaderFor(userId),
    });
  const post = (path: string, body: unknown, userId?: string) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(userId === undefined ? {} : identities.bearerHeaderFor(userId)),
      },
      body: JSON.stringify(body),
    });

  it.each(endpoints)(
    'serves %s to an administrator',
    async (path, method, response) => {
      const res = await get(path, ADMIN_ID);

      expect(res.status).toBe(HttpStatus.OK);
      await expect(res.json()).resolves.toEqual(response);
      expect(service[method]).toHaveBeenCalledOnce();
      expect(service[method]).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, limit: 20 }),
      );
    },
  );

  it.each(endpoints)(
    'refuses an unauthenticated caller on %s with 401',
    async (path, method) => {
      const res = await get(path);

      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
      expect(service[method]).not.toHaveBeenCalled();
    },
  );

  it.each(endpoints)(
    'refuses a customer on %s with 403',
    async (path, method) => {
      const res = await get(path, CUSTOMER_ID);

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(service[method]).not.toHaveBeenCalled();
    },
  );

  it('refuses a token whose ADMIN claim disagrees with the database role', async () => {
    const forged = identities.sign({
      id: CUSTOMER_ID,
      email: 'customer@example.test',
      role: Role.ADMIN,
    });

    const res = await fetch(`${base}/admin/cod-reconciliation`, {
      headers: { Authorization: `Bearer ${forged}` },
    });

    expect(res.status).toBe(HttpStatus.FORBIDDEN);
    expect(service.getCodReconciliationRecords).not.toHaveBeenCalled();
  });

  it('forwards validated filters, pagination and sorting to the service', async () => {
    const res = await get(
      '/admin/cod-reconciliation?page=2&limit=5&startDate=2026-10-01&endDate=2026-10-31&staffId=' +
        `${STAFF_ID}&orderId=${ORDER_ID}&orderNumber=%20ORD-1%20&status=DELIVERED` +
        '&currency=usd&sortBy=collectedAt&sortOrder=asc&period=daily',
      ADMIN_ID,
    );

    expect(res.status).toBe(HttpStatus.OK);
    expect(service.getCodReconciliationRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 2,
        limit: 5,
        startDate: '2026-10-01',
        endDate: '2026-10-31',
        staffId: STAFF_ID,
        orderId: ORDER_ID,
        orderNumber: 'ORD-1',
        status: 'DELIVERED',
        currency: 'USD',
        sortBy: 'collectedAt',
        sortOrder: 'asc',
        period: 'daily',
      }),
    );
  });

  it('forwards the approved query DTO to the summary and breakdown endpoints', async () => {
    await get(
      '/admin/cod-reconciliation/summary?currency=KHR&period=monthly',
      ADMIN_ID,
    );
    await get(
      '/admin/cod-reconciliation/by-staff?currency=KHR&period=monthly',
      ADMIN_ID,
    );
    await get(
      '/admin/cod-reconciliation/by-period?currency=KHR&period=monthly',
      ADMIN_ID,
    );

    for (const method of [
      service.getCodReconciliationSummary,
      service.getCodReconciliationByStaff,
      service.getCodReconciliationByPeriod,
    ]) {
      expect(method).toHaveBeenCalledWith(
        expect.objectContaining({
          currency: 'KHR',
          period: 'monthly',
          page: 1,
          limit: 20,
        }),
      );
    }
  });

  it.each([
    'page=0',
    'page=-1',
    'page=1.5',
    'page=abc',
    'limit=0',
    'limit=101',
    'startDate=not-a-date',
    'currency=US',
    'status=REFUNDED',
    'period=yearly',
    'unknownFilter=value',
  ])('rejects invalid query %s with 400', async (query) => {
    const res = await get(`/admin/cod-reconciliation?${query}`, ADMIN_ID);

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.getCodReconciliationRecords).not.toHaveBeenCalled();
  });

  it.each(endpoints)(
    'propagates a service error from %s',
    async (path, method) => {
      service[method].mockRejectedValueOnce(
        new BadRequestException('startDate must not be after endDate'),
      );

      const res = await get(path, ADMIN_ID);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service[method]).toHaveBeenCalledOnce();
    },
  );

  it.each([
    '/admin/cod-reconciliation/uncollected-orders',
    '/admin/cod-reconciliation/staff',
    '/admin/cod-reconciliation/period',
  ])('keeps the approved alternate static path %s working', async (path) => {
    const res = await get(path, ADMIN_ID);

    expect(res.status).toBe(HttpStatus.OK);
  });

  it('serves paginated run history with validated filters to an administrator', async () => {
    const res = await get(
      '/admin/cod-reconciliation/runs?page=2&limit=5&status=completed&triggerType=manual&startDate=2026-10-01&endDate=2026-10-31',
      ADMIN_ID,
    );

    expect(res.status).toBe(HttpStatus.OK);
    await expect(res.json()).resolves.toEqual(
      JSON.parse(JSON.stringify(reconciliationHistory)),
    );
    expect(reconciliationService.getRunHistory).toHaveBeenCalledWith({
      page: 2,
      limit: 5,
      status: 'completed',
      triggerType: 'manual',
      startDate: new Date('2026-10-01T00:00:00.000Z'),
      endDate: new Date('2026-10-31T23:59:59.999Z'),
    });
  });

  it.each([
    'page=0',
    'limit=101',
    'status=unknown',
    'triggerType=api',
    'startDate=2026-02-31',
    'startDate=2026-10-02&endDate=2026-10-01',
    'unknown=value',
  ])('rejects invalid run history query %s', async (query) => {
    const res = await get(`/admin/cod-reconciliation/runs?${query}`, ADMIN_ID);

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(reconciliationService.getRunHistory).not.toHaveBeenCalled();
  });

  it('protects run history and detail routes with ADMIN authorization', async () => {
    const unauthenticatedHistory = await get(
      '/admin/cod-reconciliation/runs',
    );
    const customerDetail = await get(
      `/admin/cod-reconciliation/runs/${RUN_ID}`,
      CUSTOMER_ID,
    );

    expect(unauthenticatedHistory.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(customerDetail.status).toBe(HttpStatus.FORBIDDEN);
    expect(reconciliationService.getRunHistory).not.toHaveBeenCalled();
    expect(reconciliationService.getRun).not.toHaveBeenCalled();
  });

  it('returns a run by UUID and returns 404 when it does not exist', async () => {
    const success = await get(
      `/admin/cod-reconciliation/runs/${RUN_ID}`,
      ADMIN_ID,
    );
    expect(success.status).toBe(HttpStatus.OK);
    await expect(success.json()).resolves.toEqual(
      JSON.parse(JSON.stringify(reconciliationRun)),
    );

    reconciliationService.getRun.mockRejectedValueOnce(
      new NotFoundException('Reconciliation run not found'),
    );
    const missing = await get(
      `/admin/cod-reconciliation/runs/${RUN_ID}`,
      ADMIN_ID,
    );
    expect(missing.status).toBe(HttpStatus.NOT_FOUND);
  });

  it('validates detail UUIDs before querying the service', async () => {
    const res = await get('/admin/cod-reconciliation/runs/not-a-uuid', ADMIN_ID);

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(reconciliationService.getRun).not.toHaveBeenCalled();
  });

  it('defaults manual trigger to the previous UTC calendar day', async () => {
    const res = await fetch(`${base}/admin/cod-reconciliation/runs/trigger`, {
      method: 'POST',
      headers: identities.bearerHeaderFor(ADMIN_ID),
    });

    expect(res.status).toBe(HttpStatus.CREATED);
    expect(
      reconciliationService.triggerManualReconciliation,
    ).toHaveBeenCalledWith(undefined, undefined);
  });

  it('accepts a UTC date or an explicit UTC half-open window', async () => {
    const dateResponse = await post(
      '/admin/cod-reconciliation/runs/trigger',
      { date: '2026-10-15' },
      ADMIN_ID,
    );
    const windowResponse = await post(
      '/admin/cod-reconciliation/runs/trigger',
      {
        windowStart: '2026-10-15T00:00:00.000Z',
        windowEnd: '2026-10-16T00:00:00.000Z',
      },
      ADMIN_ID,
    );

    expect(dateResponse.status).toBe(HttpStatus.CREATED);
    expect(windowResponse.status).toBe(HttpStatus.CREATED);
    expect(
      reconciliationService.triggerManualReconciliation,
    ).toHaveBeenNthCalledWith(
      1,
      new Date('2026-10-15T00:00:00.000Z'),
      new Date('2026-10-16T00:00:00.000Z'),
    );
    expect(
      reconciliationService.triggerManualReconciliation,
    ).toHaveBeenNthCalledWith(
      2,
      new Date('2026-10-15T00:00:00.000Z'),
      new Date('2026-10-16T00:00:00.000Z'),
    );
  });

  it.each([
    { date: '2026-02-31' },
    { windowStart: '2026-10-15T00:00:00Z' },
    {
      windowStart: '2026-10-16T00:00:00.000Z',
      windowEnd: '2026-10-15T00:00:00.000Z',
    },
    {
      date: '2026-10-15',
      windowStart: '2026-10-15T00:00:00.000Z',
      windowEnd: '2026-10-16T00:00:00.000Z',
    },
    { unexpected: true },
  ])('rejects invalid manual trigger body %#', async (body) => {
    const res = await post(
      '/admin/cod-reconciliation/runs/trigger',
      body,
      ADMIN_ID,
    );

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(
      reconciliationService.triggerManualReconciliation,
    ).not.toHaveBeenCalled();
  });

  it('rejects unauthorized manual triggers and reports duplicate runs as 409', async () => {
    const unauthorized = await post(
      '/admin/cod-reconciliation/runs/trigger',
      {},
    );
    const customer = await post(
      '/admin/cod-reconciliation/runs/trigger',
      {},
      CUSTOMER_ID,
    );
    expect(unauthorized.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(customer.status).toBe(HttpStatus.FORBIDDEN);
    expect(
      reconciliationService.triggerManualReconciliation,
    ).not.toHaveBeenCalled();

    reconciliationService.triggerManualReconciliation.mockRejectedValueOnce(
      new ConflictException('A reconciliation run already exists'),
    );
    const duplicate = await post(
      '/admin/cod-reconciliation/runs/trigger',
      {},
      ADMIN_ID,
    );
    expect(duplicate.status).toBe(HttpStatus.CONFLICT);
    expect(
      reconciliationService.triggerManualReconciliation,
    ).toHaveBeenCalledOnce();
  });

  it('does not expose internal errors from manual trigger failures', async () => {
    reconciliationService.triggerManualReconciliation.mockRejectedValueOnce(
      new Error('database connection string and stack trace'),
    );

    const res = await post(
      '/admin/cod-reconciliation/runs/trigger',
      {},
      ADMIN_ID,
    );

    expect(res.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    await expect(res.json()).resolves.not.toMatchObject({
      message: expect.stringContaining('database connection string'),
    });
  });
});
