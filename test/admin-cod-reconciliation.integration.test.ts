import 'dotenv/config';
import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { DeliveryStatus, Role } from '../src/generated/prisma/enums.js';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ReconciliationService } from '../src/delivery/reconciliation.service.js';
import {
  COD_RECONCILIATION_CRON,
  ReconciliationScheduler,
} from '../src/delivery/reconciliation.scheduler.js';
import {
  bearerHeaders,
  tokenIssuerFor,
  type IssueToken,
} from './support/e2e-auth.js';

type FixtureOrder = { id: string; orderNumber: string };

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface ListResponse<T> {
  items: T[];
  pagination: Pagination;
}

interface RecordItem {
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  paymentMethod: string;
  expectedAmount: string;
  currency: string;
  collectedAmount: string | null;
  collectionId: string | null;
  collectedAt: string | null;
  collectedById: string | null;
  collectedBy: { id: string } | null;
  discrepancy: boolean;
}

interface CurrencyTotal {
  currency: string;
  collectedAmount: string;
  expectedAmount: string;
  outstandingAmount: string;
  count: number;
}

interface AmountByCurrency {
  currency: string;
  totalAmount: string;
}

interface PeriodRow {
  period: string;
  currency: string;
  collectedAmount: string;
  expectedAmount: string;
  outstandingAmount: string;
  count: number;
}

interface StaffRow {
  staffId: string;
  staff: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
  currency: string;
  collectedAmount: string;
  expectedAmount: string;
  outstandingAmount: string;
  count: number;
}

interface SummaryBody {
  totalCollections: number;
  totalsByCurrency: CurrencyTotal[];
  expectedAmountByCurrency: AmountByCurrency[];
  outstandingAmountByCurrency: AmountByCurrency[];
  collectionCount: number;
  discrepancyCount: number;
  firstCollectionAt: string | null;
  lastCollectionAt: string | null;
  periodBreakdown: PeriodRow[];
  staffBreakdown: StaffRow[];
}

interface UncollectedItem {
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  expectedAmount: string;
  currency: string;
  deliveryStaffId: string | null;
  deliveryStaff: { id: string } | null;
  deliveredAt: string | null;
}

interface DiscrepancyItem {
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  discrepancyType: string;
  expectedAmount: string;
  actualAmount: string | null;
  currency: string;
  collectionId: string | null;
}

const run = randomUUID().slice(0, 8);
const codeRun = run.toUpperCase();
const corePrefix = `REC-${run}-CORE`;
const staffPrefix = `REC-${run}-STAFF`;
const periodPrefix = `REC-${run}-PER`;
const undatedPrefix = `REC-${run}-UND`;
const reconciliationRunIds: string[] = [];

const at = (iso: string) => new Date(iso);

const twoDecimals = /^\d+\.\d{2}$/;

describe('Admin COD financial reconciliation (PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let issueToken: IssueToken;
  let base: string;
  let orderCounter = 0;

  const userIds: string[] = [];
  const orderIds: string[] = [];

  let adminId: string;
  let customerId: string;
  let managerId: string;
  let staffAId: string;
  let staffBId: string;
  let staffCId: string;
  let staffDeliveryOnlyId: string;
  let staffCollectorOnlyId: string;
  let staffBothId: string;
  let staffNewId: string;
  let staffOldId: string;
  let shippingProviderId: string | undefined;
  let codAreaId: string | undefined;

  let coreExact: FixtureOrder;
  let corePartial: FixtureOrder;
  let coreMissing: FixtureOrder;
  let coreAmountMismatch: FixtureOrder;
  let coreCurrencyMismatch: FixtureOrder;
  let coreKhrExact: FixtureOrder;
  let coreReassigned: FixtureOrder;
  let periodMissing: FixtureOrder;
  let undated: FixtureOrder;

  const api = async (
    method: string,
    path: string,
    options: {
      user?: string;
      token?: string;
      query?: Record<string, string | number>;
      body?: unknown;
    } = {},
  ) => {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {};
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    } else if (options.user) {
      Object.assign(headers, bearerHeaders(issueToken, false)(options.user));
    }

    const response = await fetch(url.toString(), {
      method,
      headers,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? (JSON.parse(text) as unknown) : undefined,
    };
  };

  const adminGet = (
    path: string,
    query: Record<string, string | number> = {},
  ) => api('GET', path, { user: adminId, query });
  const adminPost = (path: string, body?: unknown) =>
    api('POST', path, {
      user: adminId,
      ...(body === undefined ? {} : { body }),
    });

  const utcPreviousDayWindow = (now = new Date()) => {
    const windowEnd = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const windowStart = new Date(windowEnd);
    windowStart.setUTCDate(windowStart.getUTCDate() - 1);
    return { windowStart, windowEnd };
  };

  const dateString = (date: Date) => date.toISOString().slice(0, 10);

  const createUser = async (
    label: string,
    role: Role,
    status = 'ACTIVE',
  ): Promise<string> => {
    const id = randomUUID();
    await prisma.user.create({
      data: {
        id,
        firstName: 'Reconciliation',
        lastName: `${label}-${run}`,
        email: `reconciliation-${run}-${label}-${id.slice(0, 8)}@example.test`,
        passwordHash: 'not-used-by-integration-tests',
        status,
        role,
      },
    });
    userIds.push(id);
    return id;
  };

  const createOrder = async (
    cohort: string,
    options: { totalAmount?: string; currency?: string } = {},
  ): Promise<FixtureOrder> => {
    orderCounter += 1;
    const orderNumber = `REC-${run}-${cohort}-${orderCounter}`;
    const totalAmount = options.totalAmount ?? '10.00';
    const order = await prisma.order.create({
      data: {
        userId: customerId,
        orderNumber,
        status: 'DELIVERED',
        subtotal: totalAmount,
        shippingFee: '0.00',
        discountAmount: '0.00',
        totalAmount,
        currency: options.currency ?? 'USD',
        paymentMethod: 'COD',
        shippingProviderId,
        shippingProviderCode: `REC-${codeRun}`,
        shippingProviderName: `Reconciliation Provider ${run}`,
        codAreaId,
        codAreaCode: `REC-${codeRun}`,
        codAreaName: `Reconciliation Area ${run}`,
        shippingRecipientName: 'Reconciliation Fixture',
        shippingPhone: '+15555550123',
        shippingAddressLine1: '1 Reconciliation Way',
        shippingCity: 'Testville',
        shippingCountryCode: 'US',
      },
      select: { id: true, orderNumber: true },
    });
    orderIds.push(order.id);
    return order;
  };

  const createAssignment = async (
    orderId: string,
    staffId: string,
    options: {
      assignedAt: Date;
      deliveredAt: Date | null;
      status?: DeliveryStatus;
    },
  ): Promise<void> => {
    await prisma.deliveryAssignment.create({
      data: {
        orderId,
        deliveryStaffId: staffId,
        assignedById: managerId,
        status: options.status ?? DeliveryStatus.DELIVERED,
        assignedAt: options.assignedAt,
        deliveredAt: options.deliveredAt,
        endedAt: options.deliveredAt,
      },
    });
  };

  const makeDeliveredOrder = async (
    cohort: string,
    options: {
      totalAmount?: string;
      currency?: string;
      staffId: string;
      deliveredAt: Date;
    },
  ): Promise<FixtureOrder> => {
    const order = await createOrder(cohort, options);
    await createAssignment(order.id, options.staffId, {
      assignedAt: new Date(options.deliveredAt.getTime() - 60 * 60 * 1000),
      deliveredAt: options.deliveredAt,
    });
    return order;
  };

  const createCollection = async (
    orderId: string,
    staffId: string,
    amount: string,
    currency: string,
    collectedAt: Date,
  ): Promise<void> => {
    await prisma.codCollection.create({
      data: {
        orderId,
        collectedById: staffId,
        amount,
        currency,
        collectedAt,
      },
    });
  };

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is not set — the reconciliation integration tests need a real PostgreSQL instance',
      );
    }

    const databaseName = new URL(process.env.DATABASE_URL).pathname;
    if (!/test/i.test(databaseName)) {
      throw new Error(
        `Refusing to run destructive reconciliation fixtures against "${databaseName}"`,
      );
    }

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0);
    base = await app.getUrl();
    prisma = app.get(PrismaService);
    issueToken = tokenIssuerFor(app);

    adminId = await createUser('admin', Role.ADMIN);
    customerId = await createUser('customer', Role.CUSTOMER);
    managerId = await createUser('manager', Role.DELIVERY_MANAGER);
    staffAId = await createUser('staff-a', Role.DELIVERY_STAFF);
    staffBId = await createUser('staff-b', Role.DELIVERY_STAFF);
    staffCId = await createUser('staff-c', Role.DELIVERY_STAFF);
    staffDeliveryOnlyId = await createUser(
      'staff-delivery-only',
      Role.DELIVERY_STAFF,
    );
    staffCollectorOnlyId = await createUser(
      'staff-collector-only',
      Role.DELIVERY_STAFF,
    );
    staffBothId = await createUser('staff-both', Role.DELIVERY_STAFF);
    staffNewId = await createUser('staff-new', Role.DELIVERY_STAFF);
    staffOldId = await createUser('staff-old', Role.DELIVERY_STAFF);

    const provider = await prisma.shippingProvider.create({
      data: {
        code: `REC-${codeRun}`,
        name: `Reconciliation Provider ${run}`,
        baseFee: '0.00',
        supportsCod: true,
        isActive: true,
      },
      select: { id: true },
    });
    shippingProviderId = provider.id;

    const codArea = await prisma.codArea.create({
      data: {
        code: `REC-${codeRun}`,
        name: `Reconciliation Area ${run}`,
        codEnabled: true,
      },
      select: { id: true },
    });
    codAreaId = codArea.id;

    // Core cohort: every monetary branch in one stable order-number namespace.
    coreExact = await makeDeliveredOrder('CORE', {
      totalAmount: '100.10',
      staffId: staffAId,
      deliveredAt: at('2026-01-05T10:00:00Z'),
    });
    await createCollection(
      coreExact.id,
      staffAId,
      '100.10',
      'USD',
      at('2026-01-05T10:05:00Z'),
    );

    corePartial = await makeDeliveredOrder('CORE', {
      totalAmount: '100.20',
      staffId: staffAId,
      deliveredAt: at('2026-01-05T11:00:00Z'),
    });
    await createCollection(
      corePartial.id,
      staffAId,
      '60.10',
      'USD',
      at('2026-01-05T11:05:00Z'),
    );

    coreMissing = await makeDeliveredOrder('CORE', {
      totalAmount: '50.05',
      staffId: staffBId,
      deliveredAt: at('2026-01-06T09:00:00Z'),
    });

    coreAmountMismatch = await makeDeliveredOrder('CORE', {
      totalAmount: '80.08',
      staffId: staffBId,
      deliveredAt: at('2026-01-06T12:00:00Z'),
    });
    await createCollection(
      coreAmountMismatch.id,
      staffBId,
      '70.07',
      'USD',
      at('2026-01-06T12:05:00Z'),
    );

    coreCurrencyMismatch = await makeDeliveredOrder('CORE', {
      totalAmount: '40.04',
      staffId: staffBId,
      deliveredAt: at('2026-01-06T13:00:00Z'),
    });
    await createCollection(
      coreCurrencyMismatch.id,
      staffBId,
      '160000.00',
      'KHR',
      at('2026-01-06T13:05:00Z'),
    );

    coreKhrExact = await makeDeliveredOrder('CORE', {
      totalAmount: '40000.00',
      currency: 'KHR',
      staffId: staffCId,
      deliveredAt: at('2026-01-07T10:00:00Z'),
    });
    await createCollection(
      coreKhrExact.id,
      staffCId,
      '40000.00',
      'KHR',
      at('2026-01-07T10:05:00Z'),
    );

    coreReassigned = await createOrder('CORE', { totalAmount: '30.03' });
    await createAssignment(coreReassigned.id, staffAId, {
      assignedAt: at('2026-01-07T09:00:00Z'),
      deliveredAt: at('2026-01-07T10:00:00Z'),
    });
    await createAssignment(coreReassigned.id, staffBId, {
      assignedAt: at('2026-01-08T09:00:00Z'),
      deliveredAt: at('2026-01-08T10:00:00Z'),
    });
    await createCollection(
      coreReassigned.id,
      staffAId,
      '30.03',
      'USD',
      at('2026-01-08T10:05:00Z'),
    );

    // Staff cohort: delivery-only, collection-only, both, and reassignment.
    await makeDeliveredOrder('STAFF', {
      totalAmount: '70.00',
      staffId: staffDeliveryOnlyId,
      deliveredAt: at('2026-04-01T09:00:00Z'),
    });

    const staffCollectedByOther = await makeDeliveredOrder('STAFF', {
      totalAmount: '80.00',
      staffId: staffDeliveryOnlyId,
      deliveredAt: at('2026-04-01T11:00:00Z'),
    });
    await createCollection(
      staffCollectedByOther.id,
      staffCollectorOnlyId,
      '80.00',
      'USD',
      at('2026-04-01T11:05:00Z'),
    );

    const staffBothUsd = await makeDeliveredOrder('STAFF', {
      totalAmount: '50.00',
      staffId: staffBothId,
      deliveredAt: at('2026-04-01T12:00:00Z'),
    });
    await createCollection(
      staffBothUsd.id,
      staffBothId,
      '50.00',
      'USD',
      at('2026-04-01T12:05:00Z'),
    );

    const staffReassigned = await createOrder('STAFF', {
      totalAmount: '30.00',
    });
    await createAssignment(staffReassigned.id, staffOldId, {
      assignedAt: at('2026-04-02T09:00:00Z'),
      deliveredAt: at('2026-04-02T10:00:00Z'),
    });
    await createAssignment(staffReassigned.id, staffNewId, {
      assignedAt: at('2026-04-03T09:00:00Z'),
      deliveredAt: at('2026-04-03T10:00:00Z'),
    });
    await createCollection(
      staffReassigned.id,
      staffOldId,
      '30.00',
      'USD',
      at('2026-04-03T10:05:00Z'),
    );

    const staffReassignedUncollected = await createOrder('STAFF', {
      totalAmount: '40.00',
    });
    await createAssignment(staffReassignedUncollected.id, staffOldId, {
      assignedAt: at('2026-04-04T09:00:00Z'),
      deliveredAt: at('2026-04-04T10:00:00Z'),
    });
    await createAssignment(staffReassignedUncollected.id, staffNewId, {
      assignedAt: at('2026-04-05T09:00:00Z'),
      deliveredAt: at('2026-04-05T10:00:00Z'),
    });

    const staffBothKhr = await makeDeliveredOrder('STAFF', {
      totalAmount: '40000.00',
      currency: 'KHR',
      staffId: staffBothId,
      deliveredAt: at('2026-04-01T13:00:00Z'),
    });
    await createCollection(
      staffBothKhr.id,
      staffBothId,
      '40000.00',
      'KHR',
      at('2026-04-01T13:05:00Z'),
    );

    // Period cohort: month/week/day boundaries plus an undated delivered row.
    const periodExact = await makeDeliveredOrder('PER', {
      totalAmount: '10.00',
      staffId: staffAId,
      deliveredAt: at('2026-02-02T10:00:00Z'),
    });
    await createCollection(
      periodExact.id,
      staffAId,
      '10.00',
      'USD',
      at('2026-02-02T10:05:00Z'),
    );

    periodMissing = await makeDeliveredOrder('PER', {
      totalAmount: '20.00',
      staffId: staffAId,
      deliveredAt: at('2026-02-08T10:00:00Z'),
    });

    const periodNextWeek = await makeDeliveredOrder('PER', {
      totalAmount: '30.00',
      staffId: staffAId,
      deliveredAt: at('2026-02-09T10:00:00Z'),
    });
    await createCollection(
      periodNextWeek.id,
      staffAId,
      '30.00',
      'USD',
      at('2026-02-09T10:05:00Z'),
    );

    const periodNextWeekKhr = await makeDeliveredOrder('PER', {
      totalAmount: '20000.00',
      currency: 'KHR',
      staffId: staffAId,
      deliveredAt: at('2026-02-09T12:00:00Z'),
    });
    await createCollection(
      periodNextWeekKhr.id,
      staffAId,
      '20000.00',
      'KHR',
      at('2026-02-09T12:05:00Z'),
    );

    const periodMarch = await makeDeliveredOrder('PER', {
      totalAmount: '40000.00',
      currency: 'KHR',
      staffId: staffAId,
      deliveredAt: at('2026-03-02T10:00:00Z'),
    });
    await createCollection(
      periodMarch.id,
      staffAId,
      '40000.00',
      'KHR',
      at('2026-03-02T10:05:00Z'),
    );

    const periodUndated = await createOrder('PER', { totalAmount: '5.00' });
    await createAssignment(periodUndated.id, staffAId, {
      assignedAt: at('2026-02-01T10:00:00Z'),
      deliveredAt: null,
    });

    // Delivered without delivered_at and without a collection.
    undated = await createOrder('UND', { totalAmount: '20.00' });
    await createAssignment(undated.id, staffCId, {
      assignedAt: at('2026-01-01T09:00:00Z'),
      deliveredAt: null,
    });
  }, 120_000);

  afterAll(async () => {
    if (!prisma) {
      return;
    }

    await prisma.codReconciliationRun.deleteMany({
      where: { id: { in: reconciliationRunIds } },
    });
    await prisma.codCollection.deleteMany({
      where: {
        OR: [{ orderId: { in: orderIds } }, { collectedById: { in: userIds } }],
      },
    });
    await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.deliveryAssignment.deleteMany({
      where: {
        OR: [
          { orderId: { in: orderIds } },
          { deliveryStaffId: { in: userIds } },
          { assignedById: { in: userIds } },
        ],
      },
    });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    if (codAreaId) {
      await prisma.codArea.deleteMany({ where: { id: codAreaId } });
    }
    if (shippingProviderId) {
      await prisma.shippingProvider.deleteMany({
        where: { id: shippingProviderId },
      });
    }
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });

    await app.close();
  });

  describe('GET /admin/cod-reconciliation', () => {
    it('reconciles every branch without duplicating orders or using floats', async () => {
      const res = await adminGet('/admin/cod-reconciliation', {
        orderNumber: corePrefix,
      });

      expect(res.status).toBe(HttpStatus.OK);
      const body = res.body as ListResponse<RecordItem>;

      expect(body.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 7,
        totalPages: 1,
      });
      expect(body.items).toHaveLength(7);

      const byOrderId = new Map(body.items.map((item) => [item.orderId, item]));
      expect(byOrderId.size).toBe(7);

      expect(byOrderId.get(coreExact.id)).toMatchObject({
        orderStatus: 'DELIVERED',
        paymentMethod: 'COD',
        expectedAmount: '100.10',
        currency: 'USD',
        collectedAmount: '100.10',
        collectedById: staffAId,
        discrepancy: false,
      });

      expect(byOrderId.get(corePartial.id)).toMatchObject({
        expectedAmount: '100.20',
        collectedAmount: '60.10',
        discrepancy: true,
      });

      expect(byOrderId.get(coreMissing.id)).toMatchObject({
        expectedAmount: '50.05',
        collectedAmount: null,
        collectionId: null,
        collectedAt: null,
        collectedById: null,
        discrepancy: true,
      });

      expect(byOrderId.get(coreAmountMismatch.id)).toMatchObject({
        expectedAmount: '80.08',
        collectedAmount: '70.07',
        discrepancy: true,
      });

      expect(byOrderId.get(coreCurrencyMismatch.id)).toMatchObject({
        expectedAmount: '40.04',
        collectedAmount: '160000.00',
        currency: 'USD',
        discrepancy: true,
      });

      expect(byOrderId.get(coreKhrExact.id)).toMatchObject({
        expectedAmount: '40000.00',
        collectedAmount: '40000.00',
        currency: 'KHR',
        discrepancy: false,
      });

      expect(byOrderId.get(coreReassigned.id)).toMatchObject({
        expectedAmount: '30.03',
        collectedAmount: '30.03',
        collectedById: staffAId,
        discrepancy: false,
      });
      expect(byOrderId.get(coreReassigned.id)?.collectedBy?.id).toBe(staffAId);

      for (const item of body.items) {
        expect(item.expectedAmount).toMatch(twoDecimals);
        if (item.collectedAmount !== null) {
          expect(item.collectedAmount).toMatch(twoDecimals);
        }
      }

      // Every core order deliberately has no Payment row. An exact collection
      // must still reconcile cleanly, proving payment presence is not part of
      // the discrepancy classifier.
      const coreOrderIds = [
        coreExact.id,
        corePartial.id,
        coreMissing.id,
        coreAmountMismatch.id,
        coreCurrencyMismatch.id,
        coreKhrExact.id,
        coreReassigned.id,
      ];
      expect(
        await prisma.payment.count({
          where: { orderId: { in: coreOrderIds } },
        }),
      ).toBe(0);
    });

    it('paginates and filters through the HTTP endpoint', async () => {
      const first = await adminGet('/admin/cod-reconciliation', {
        orderNumber: corePrefix,
        page: 1,
        limit: 2,
      });
      const second = await adminGet('/admin/cod-reconciliation', {
        orderNumber: corePrefix,
        page: 2,
        limit: 2,
      });

      expect(first.status).toBe(HttpStatus.OK);
      expect(second.status).toBe(HttpStatus.OK);
      const firstBody = first.body as ListResponse<RecordItem>;
      const secondBody = second.body as ListResponse<RecordItem>;

      expect(firstBody.pagination).toEqual({
        page: 1,
        limit: 2,
        total: 7,
        totalPages: 4,
      });
      expect(firstBody.items).toHaveLength(2);
      expect(secondBody.items).toHaveLength(2);
      expect(
        new Set([
          ...firstBody.items.map((item) => item.orderId),
          ...secondBody.items.map((item) => item.orderId),
        ]).size,
      ).toBe(4);

      const khr = await adminGet('/admin/cod-reconciliation', {
        orderNumber: corePrefix,
        currency: 'khr',
      });
      const khrBody = khr.body as ListResponse<RecordItem>;
      expect(khr.status).toBe(HttpStatus.OK);
      expect(khrBody.pagination.total).toBe(1);
      expect(khrBody.items[0]).toMatchObject({
        orderId: coreKhrExact.id,
        currency: 'KHR',
      });

      const byOrder = await adminGet('/admin/cod-reconciliation', {
        orderNumber: corePrefix,
        orderId: coreReassigned.id,
      });
      const byOrderBody = byOrder.body as ListResponse<RecordItem>;
      expect(byOrderBody.pagination.total).toBe(1);
      expect(byOrderBody.items[0]?.orderId).toBe(coreReassigned.id);
    });
  });

  describe('GET /admin/cod-reconciliation/summary', () => {
    it('keeps currencies separate and reconciles cents exactly', async () => {
      const res = await adminGet('/admin/cod-reconciliation/summary', {
        orderNumber: corePrefix,
      });

      expect(res.status).toBe(HttpStatus.OK);
      const body = res.body as SummaryBody;
      expect(body.totalsByCurrency).toHaveLength(2);

      const totals = new Map(
        body.totalsByCurrency.map((entry) => [entry.currency, entry]),
      );
      expect(totals.get('USD')).toEqual({
        currency: 'USD',
        expectedAmount: '400.50',
        collectedAmount: '260.30',
        outstandingAmount: '140.20',
        count: 4,
      });
      expect(totals.get('KHR')).toEqual({
        currency: 'KHR',
        expectedAmount: '40000.00',
        collectedAmount: '200000.00',
        outstandingAmount: '0.00',
        count: 2,
      });

      expect(body.totalCollections).toBe(6);
      expect(body.collectionCount).toBe(6);
      expect(body.discrepancyCount).toBe(4);
      expect(body.firstCollectionAt).toBe('2026-01-05T10:05:00.000Z');
      expect(body.lastCollectionAt).toBe('2026-01-08T10:05:00.000Z');

      expect(body.expectedAmountByCurrency).toEqual(
        expect.arrayContaining([
          { currency: 'USD', totalAmount: '400.50' },
          { currency: 'KHR', totalAmount: '40000.00' },
        ]),
      );
      expect(body.outstandingAmountByCurrency).toEqual(
        expect.arrayContaining([
          { currency: 'USD', totalAmount: '140.20' },
          { currency: 'KHR', totalAmount: '0.00' },
        ]),
      );

      expect(body.periodBreakdown).toHaveLength(5);
      expect(body.staffBreakdown.length).toBeGreaterThan(0);
      for (const entry of body.totalsByCurrency) {
        expect(entry.expectedAmount).toMatch(twoDecimals);
        expect(entry.collectedAmount).toMatch(twoDecimals);
        expect(entry.outstandingAmount).toMatch(twoDecimals);
      }
    });
  });

  describe('GET /admin/cod-reconciliation/uncollected', () => {
    it('returns only delivered COD orders with no collection', async () => {
      const res = await adminGet('/admin/cod-reconciliation/uncollected', {
        orderNumber: corePrefix,
      });

      expect(res.status).toBe(HttpStatus.OK);
      const body = res.body as ListResponse<UncollectedItem>;
      expect(body.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
      });
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        orderId: coreMissing.id,
        orderNumber: coreMissing.orderNumber,
        orderStatus: 'DELIVERED',
        expectedAmount: '50.05',
        currency: 'USD',
        deliveryStaffId: staffBId,
        deliveredAt: '2026-01-06T09:00:00.000Z',
      });
      expect(body.items[0]?.deliveryStaff?.id).toBe(staffBId);
      expect(body.items[0]?.expectedAmount).toMatch(twoDecimals);
    });
  });

  describe('GET /admin/cod-reconciliation/discrepancies', () => {
    it('classifies missing, amount and currency discrepancies explicitly', async () => {
      const res = await adminGet('/admin/cod-reconciliation/discrepancies', {
        orderNumber: corePrefix,
      });

      expect(res.status).toBe(HttpStatus.OK);
      const body = res.body as ListResponse<DiscrepancyItem>;
      expect(body.pagination.total).toBe(4);
      expect(body.items).toHaveLength(4);

      const byOrderId = new Map(body.items.map((item) => [item.orderId, item]));
      expect(byOrderId.size).toBe(4);

      expect(byOrderId.get(corePartial.id)).toMatchObject({
        discrepancyType: 'amount-mismatch',
        expectedAmount: '100.20',
        actualAmount: '60.10',
        currency: 'USD',
      });

      expect(byOrderId.get(coreMissing.id)).toMatchObject({
        discrepancyType: 'missing-collection',
        expectedAmount: '50.05',
        actualAmount: null,
        currency: 'USD',
        collectionId: null,
      });

      expect(byOrderId.get(coreAmountMismatch.id)).toMatchObject({
        discrepancyType: 'amount-mismatch',
        expectedAmount: '80.08',
        actualAmount: '70.07',
        currency: 'USD',
      });

      expect(byOrderId.get(coreCurrencyMismatch.id)).toMatchObject({
        discrepancyType: 'currency-mismatch',
        expectedAmount: '40.04',
        actualAmount: '160000.00',
        currency: 'USD',
      });
      expect(byOrderId.get(coreCurrencyMismatch.id)?.collectionId).toBeTruthy();

      for (const orderId of [
        coreExact.id,
        coreKhrExact.id,
        coreReassigned.id,
      ]) {
        expect(byOrderId.has(orderId)).toBe(false);
      }

      // All core orders have no Payment row; the four discrepancies above come
      // from collection reconciliation, not from payment-row absence.
      expect(
        await prisma.payment.count({
          where: {
            orderId: {
              in: [
                coreExact.id,
                corePartial.id,
                coreMissing.id,
                coreAmountMismatch.id,
                coreCurrencyMismatch.id,
                coreKhrExact.id,
                coreReassigned.id,
              ],
            },
          },
        }),
      ).toBe(0);
    });
  });

  describe('GET /admin/cod-reconciliation/by-staff', () => {
    it('attributes delivery and collection independently per staff member', async () => {
      const res = await adminGet('/admin/cod-reconciliation/by-staff', {
        orderNumber: staffPrefix,
      });

      expect(res.status).toBe(HttpStatus.OK);
      const rows = res.body as StaffRow[];
      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toHaveLength(6);

      const byStaffAndCurrency = new Map(
        rows.map((row) => [`${row.staffId}|${row.currency}`, row]),
      );

      expect(
        byStaffAndCurrency.get(`${staffDeliveryOnlyId}|USD`),
      ).toMatchObject({
        expectedAmount: '150.00',
        collectedAmount: '0.00',
        // The 80.00 order was collected by another staff member, so it is no
        // longer outstanding for the courier who delivered it.
        outstandingAmount: '70.00',
        count: 0,
      });
      expect(
        byStaffAndCurrency.get(`${staffCollectorOnlyId}|USD`),
      ).toMatchObject({
        expectedAmount: '0.00',
        collectedAmount: '80.00',
        outstandingAmount: '0.00',
        count: 1,
      });
      expect(byStaffAndCurrency.get(`${staffBothId}|USD`)).toMatchObject({
        expectedAmount: '50.00',
        collectedAmount: '50.00',
        outstandingAmount: '0.00',
        count: 1,
      });
      expect(byStaffAndCurrency.get(`${staffBothId}|KHR`)).toMatchObject({
        expectedAmount: '40000.00',
        collectedAmount: '40000.00',
        outstandingAmount: '0.00',
        count: 1,
      });
      expect(byStaffAndCurrency.get(`${staffNewId}|USD`)).toMatchObject({
        expectedAmount: '70.00',
        collectedAmount: '0.00',
        // 30.00 was collected by the previous courier; the other 40.00 is
        // outstanding against the latest delivered assignment.
        outstandingAmount: '40.00',
        count: 0,
      });
      expect(byStaffAndCurrency.get(`${staffOldId}|USD`)).toMatchObject({
        expectedAmount: '0.00',
        collectedAmount: '30.00',
        outstandingAmount: '0.00',
        count: 1,
      });

      for (const row of rows) {
        expect(row.staff.id).toBe(row.staffId);
        expect(row.expectedAmount).toMatch(twoDecimals);
        expect(row.collectedAmount).toMatch(twoDecimals);
        expect(row.outstandingAmount).toMatch(twoDecimals);
      }

      const filtered = await adminGet('/admin/cod-reconciliation/by-staff', {
        orderNumber: staffPrefix,
        staffId: staffDeliveryOnlyId,
      });
      const filteredRows = filtered.body as StaffRow[];
      expect(filteredRows).toHaveLength(1);
      expect(filteredRows[0]).toMatchObject({
        staffId: staffDeliveryOnlyId,
        currency: 'USD',
        expectedAmount: '150.00',
      });
    });
  });

  describe('GET /admin/cod-reconciliation/by-period', () => {
    const indexRows = (rows: PeriodRow[]) =>
      new Map(rows.map((row) => [`${row.period}|${row.currency}`, row]));

    it('groups daily rows without mixing currencies', async () => {
      const res = await adminGet('/admin/cod-reconciliation/by-period', {
        orderNumber: periodPrefix,
      });

      expect(res.status).toBe(HttpStatus.OK);
      const rows = res.body as PeriodRow[];
      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toHaveLength(5);

      const byPeriod = indexRows(rows);
      expect(byPeriod.get('2026-02-02|USD')).toMatchObject({
        expectedAmount: '10.00',
        collectedAmount: '10.00',
        outstandingAmount: '0.00',
        count: 1,
      });
      expect(byPeriod.get('2026-02-08|USD')).toMatchObject({
        expectedAmount: '20.00',
        collectedAmount: '0.00',
        outstandingAmount: '20.00',
        count: 0,
      });
      expect(byPeriod.get('2026-02-09|USD')).toMatchObject({
        expectedAmount: '30.00',
        collectedAmount: '30.00',
        outstandingAmount: '0.00',
        count: 1,
      });
      expect(byPeriod.get('2026-02-09|KHR')).toMatchObject({
        expectedAmount: '20000.00',
        collectedAmount: '20000.00',
        outstandingAmount: '0.00',
        count: 1,
      });
      expect(byPeriod.get('2026-03-02|KHR')).toMatchObject({
        expectedAmount: '40000.00',
        collectedAmount: '40000.00',
        outstandingAmount: '0.00',
        count: 1,
      });
      expect(
        [...byPeriod.keys()].some(
          (key) => key.includes('|USD') && key.startsWith('2026-03'),
        ),
      ).toBe(false);
    });

    it('groups weekly and monthly rows through the period query', async () => {
      const weeklyRes = await adminGet('/admin/cod-reconciliation/by-period', {
        orderNumber: periodPrefix,
        period: 'weekly',
      });
      const weekly = indexRows(weeklyRes.body as PeriodRow[]);
      expect(weeklyRes.status).toBe(HttpStatus.OK);
      expect(weekly.size).toBe(4);
      expect(weekly.get('2026-02-02|USD')).toMatchObject({
        expectedAmount: '30.00',
        collectedAmount: '10.00',
        outstandingAmount: '20.00',
        count: 1,
      });
      expect(weekly.get('2026-02-09|USD')).toMatchObject({
        expectedAmount: '30.00',
        collectedAmount: '30.00',
        outstandingAmount: '0.00',
        count: 1,
      });
      expect(weekly.get('2026-02-09|KHR')).toMatchObject({
        expectedAmount: '20000.00',
        collectedAmount: '20000.00',
        outstandingAmount: '0.00',
        count: 1,
      });
      expect(weekly.get('2026-03-02|KHR')).toMatchObject({
        expectedAmount: '40000.00',
        collectedAmount: '40000.00',
        count: 1,
      });

      const monthlyRes = await adminGet('/admin/cod-reconciliation/by-period', {
        orderNumber: periodPrefix,
        period: 'monthly',
      });
      const monthly = indexRows(monthlyRes.body as PeriodRow[]);
      expect(monthlyRes.status).toBe(HttpStatus.OK);
      expect(monthly.size).toBe(3);
      expect(monthly.get('2026-02|USD')).toMatchObject({
        expectedAmount: '60.00',
        collectedAmount: '40.00',
        outstandingAmount: '20.00',
        count: 2,
      });
      expect(monthly.get('2026-02|KHR')).toMatchObject({
        expectedAmount: '20000.00',
        collectedAmount: '20000.00',
        outstandingAmount: '0.00',
        count: 1,
      });
      expect(monthly.get('2026-03|KHR')).toMatchObject({
        expectedAmount: '40000.00',
        collectedAmount: '40000.00',
        count: 1,
      });
    });
  });

  describe('date filters and undated deliveries', () => {
    it('excludes undated delivered orders from date-filtered cohorts', async () => {
      const unfiltered = await adminGet('/admin/cod-reconciliation', {
        orderNumber: undatedPrefix,
      });
      const unfilteredBody = unfiltered.body as ListResponse<RecordItem>;
      expect(unfiltered.status).toBe(HttpStatus.OK);
      expect(unfilteredBody.pagination.total).toBe(1);
      expect(unfilteredBody.items[0]).toMatchObject({
        orderId: undated.id,
        expectedAmount: '20.00',
        collectedAmount: null,
        discrepancy: true,
      });

      const dated = await adminGet('/admin/cod-reconciliation', {
        orderNumber: undatedPrefix,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      });
      expect((dated.body as ListResponse<RecordItem>).pagination.total).toBe(0);

      const uncollected = await adminGet(
        '/admin/cod-reconciliation/uncollected',
        { orderNumber: undatedPrefix },
      );
      const uncollectedBody = uncollected.body as ListResponse<UncollectedItem>;
      expect(uncollectedBody.pagination.total).toBe(1);
      expect(uncollectedBody.items[0]).toMatchObject({
        orderId: undated.id,
        expectedAmount: '20.00',
        deliveredAt: null,
      });

      const uncollectedDated = await adminGet(
        '/admin/cod-reconciliation/uncollected',
        {
          orderNumber: undatedPrefix,
          startDate: '2026-01-01',
          endDate: '2026-12-31',
        },
      );
      expect(
        (uncollectedDated.body as ListResponse<UncollectedItem>).pagination
          .total,
      ).toBe(0);

      const period = await adminGet('/admin/cod-reconciliation/by-period', {
        orderNumber: undatedPrefix,
      });
      expect(period.status).toBe(HttpStatus.OK);
      expect(period.body).toEqual([]);
    });

    it('applies inclusive UTC date filters through the endpoints', async () => {
      const records = await adminGet('/admin/cod-reconciliation', {
        orderNumber: periodPrefix,
        startDate: '2026-02-02',
        endDate: '2026-02-08',
      });
      const recordsBody = records.body as ListResponse<RecordItem>;
      expect(records.status).toBe(HttpStatus.OK);
      expect(recordsBody.pagination.total).toBe(2);
      expect(
        recordsBody.items.map((item) => item.expectedAmount).sort(),
      ).toEqual(['10.00', '20.00']);

      const uncollected = await adminGet(
        '/admin/cod-reconciliation/uncollected',
        {
          orderNumber: periodPrefix,
          startDate: '2026-02-02',
          endDate: '2026-02-08',
        },
      );
      const uncollectedBody = uncollected.body as ListResponse<UncollectedItem>;
      expect(uncollectedBody.pagination.total).toBe(1);
      expect(uncollectedBody.items[0]?.orderId).toBe(periodMissing.id);

      const summary = await adminGet('/admin/cod-reconciliation/summary', {
        orderNumber: periodPrefix,
        startDate: '2026-02-02',
        endDate: '2026-02-08',
      });
      const summaryBody = summary.body as SummaryBody;
      expect(summaryBody.totalCollections).toBe(1);
      expect(summaryBody.totalsByCurrency).toEqual([
        {
          currency: 'USD',
          expectedAmount: '30.00',
          collectedAmount: '10.00',
          outstandingAmount: '20.00',
          count: 1,
        },
      ]);
      expect(summaryBody.discrepancyCount).toBe(1);
      expect(summaryBody.firstCollectionAt).toBe('2026-02-02T10:05:00.000Z');
      expect(summaryBody.periodBreakdown).toHaveLength(2);

      const byPeriod = await adminGet('/admin/cod-reconciliation/by-period', {
        orderNumber: periodPrefix,
        startDate: '2026-02-02',
        endDate: '2026-02-08',
      });
      const periodRows = byPeriod.body as PeriodRow[];
      expect(periodRows).toHaveLength(2);
      expect(periodRows.map((row) => row.period).sort()).toEqual([
        '2026-02-02',
        '2026-02-08',
      ]);
    });
  });

  describe('COD reconciliation run API', () => {
    it('discovers and registers the reconciliation scheduler during application bootstrap', () => {
      expect(app.get(ReconciliationScheduler)).toBeInstanceOf(
        ReconciliationScheduler,
      );
      expect(
        app
          .get(SchedulerRegistry)
          .getCronJobs()
          .has(COD_RECONCILIATION_CRON),
      ).toBe(true);
    });

    it('manually reconciles an explicit UTC window and leaves financial rows unchanged', async () => {
      const { windowStart, windowEnd } = utcPreviousDayWindow();
      const deliveredAt = new Date(windowStart.getTime() + 12 * 60 * 60 * 1000);
      const exact = await makeDeliveredOrder('RUN-EXACT', {
        totalAmount: '11.11',
        currency: 'USD',
        staffId: staffAId,
        deliveredAt,
      });
      await createCollection(
        exact.id,
        staffAId,
        '11.11',
        'USD',
        new Date(deliveredAt.getTime() + 5 * 60 * 1000),
      );

      const missing = await makeDeliveredOrder('RUN-MISSING', {
        totalAmount: '22.22',
        currency: 'KHR',
        staffId: staffAId,
        deliveredAt: new Date(deliveredAt.getTime() + 60 * 60 * 1000),
      });
      const mismatched = await makeDeliveredOrder('RUN-MISMATCH', {
        totalAmount: '33.33',
        currency: 'USD',
        staffId: staffAId,
        deliveredAt: new Date(deliveredAt.getTime() + 2 * 60 * 60 * 1000),
      });
      await createCollection(
        mismatched.id,
        staffAId,
        '30.00',
        'USD',
        new Date(deliveredAt.getTime() + 2 * 60 * 60 * 1000 + 5 * 60 * 1000),
      );

      const fixtureIds = [exact.id, missing.id, mismatched.id].sort();
      const financialSnapshot = async () => {
        const [orders, payments, collections] = await Promise.all([
          prisma.order.findMany({
            where: { id: { in: fixtureIds } },
            orderBy: { id: 'asc' },
            select: { id: true, status: true, totalAmount: true, currency: true },
          }),
          prisma.payment.findMany({
            where: { orderId: { in: fixtureIds } },
            orderBy: { id: 'asc' },
            select: { id: true, status: true, amount: true, currency: true },
          }),
          prisma.codCollection.findMany({
            where: { orderId: { in: fixtureIds } },
            orderBy: { id: 'asc' },
            select: { id: true, orderId: true, amount: true, currency: true },
          }),
        ]);
        return {
          orders: orders.map((row) => ({
            ...row,
            totalAmount: row.totalAmount.toString(),
          })),
          payments: payments.map((row) => ({
            ...row,
            amount: row.amount.toString(),
          })),
          collections: collections.map((row) => ({
            ...row,
            amount: row.amount.toString(),
          })),
        };
      };

      const before = await financialSnapshot();
      const result = await adminPost('/admin/cod-reconciliation/runs/trigger', {
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
      });

      expect(result.status).toBe(HttpStatus.CREATED);
      const body = result.body as {
        run: {
          id: string;
          triggerType: string;
          status: string;
          windowStart: string;
          windowEnd: string;
        };
        counters: {
          processedCount: number;
          matchedCount: number;
          discrepancyCount: number;
          uncollectedCount: number;
        };
        discrepancyBreakdown: {
          missingCollections: number;
          amountMismatches: number;
          currencyMismatches: number;
        };
      };
      reconciliationRunIds.push(body.run.id);
      expect(body.run).toMatchObject({
        triggerType: 'manual',
        status: 'completed',
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
      });
      expect(body.counters).toEqual({
        processedCount: 3,
        matchedCount: 1,
        discrepancyCount: 2,
        uncollectedCount: 1,
      });
      expect(body.discrepancyBreakdown).toEqual({
        missingCollections: 1,
        amountMismatches: 1,
        currencyMismatches: 0,
      });
      expect(await financialSnapshot()).toEqual(before);
    });

    it('reconciles the previous UTC day for a cron trigger', async () => {
      const { windowStart, windowEnd } = utcPreviousDayWindow();
      const service = app.get(ReconciliationService);
      const result = await service.reconcileWindow(
        windowStart,
        windowEnd,
        'cron',
      );

      expect(result).not.toBeNull();
      reconciliationRunIds.push(result!.run.id);
      expect(result!.run).toMatchObject({
        triggerType: 'cron',
        status: 'completed',
        windowStart,
        windowEnd,
      });
    });

    it('filters and paginates history, retrieves detail, and returns 404 for missing runs', async () => {
      const runDayBase = new Date(Date.UTC(2001, 0, 1));
      runDayBase.setUTCDate(
        runDayBase.getUTCDate() + (Number.parseInt(run, 16) % 7000),
      );
      const runDays = [0, 1, 2].map((offset) => {
        const day = new Date(runDayBase);
        day.setUTCDate(day.getUTCDate() + offset);
        return dateString(day);
      });

      const createdRunIds: string[] = [];
      for (const date of runDays) {
        const response = await adminPost(
          '/admin/cod-reconciliation/runs/trigger',
          { date },
        );
        expect(response.status).toBe(HttpStatus.CREATED);
        const body = response.body as { run: { id: string } };
        reconciliationRunIds.push(body.run.id);
        createdRunIds.push(body.run.id);
      }

      const firstPage = await adminGet('/admin/cod-reconciliation/runs', {
        page: 1,
        limit: 2,
        status: 'completed',
        triggerType: 'manual',
        startDate: runDays[0]!,
        endDate: runDays[2]!,
      });
      const secondPage = await adminGet('/admin/cod-reconciliation/runs', {
        page: 2,
        limit: 2,
        status: 'completed',
        triggerType: 'manual',
        startDate: runDays[0]!,
        endDate: runDays[2]!,
      });

      expect(firstPage.status).toBe(HttpStatus.OK);
      expect(secondPage.status).toBe(HttpStatus.OK);
      const first = firstPage.body as {
        items: Array<{ id: string }>;
        total: number;
        totalPages: number;
        page: number;
      };
      const second = secondPage.body as {
        items: Array<{ id: string }>;
        total: number;
        totalPages: number;
        page: number;
      };
      expect(first).toMatchObject({ total: 3, totalPages: 2, page: 1 });
      expect(second).toMatchObject({ total: 3, totalPages: 2, page: 2 });
      expect(first.items).toHaveLength(2);
      expect(second.items).toHaveLength(1);
      expect(
        new Set([...first.items, ...second.items].map((item) => item.id)),
      ).toEqual(new Set(createdRunIds));

      const detail = await adminGet(
        `/admin/cod-reconciliation/runs/${createdRunIds[0]}`,
      );
      expect(detail.status).toBe(HttpStatus.OK);
      expect((detail.body as { id: string }).id).toBe(createdRunIds[0]);

      const missing = await adminGet(
        `/admin/cod-reconciliation/runs/${randomUUID()}`,
      );
      expect(missing.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('returns a conflict for concurrent manual triggers of the same window', async () => {
      const start = new Date('2000-01-01T04:05:06.789Z');
      const end = new Date('2000-01-02T04:05:06.789Z');
      const body = {
        windowStart: start.toISOString(),
        windowEnd: end.toISOString(),
      };

      const responses = await Promise.all([
        adminPost('/admin/cod-reconciliation/runs/trigger', body),
        adminPost('/admin/cod-reconciliation/runs/trigger', body),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([
        HttpStatus.CREATED,
        HttpStatus.CONFLICT,
      ]);
      const created = responses.find(
        (response) => response.status === HttpStatus.CREATED,
      );
      expect(created).toBeDefined();
      reconciliationRunIds.push(
        (created!.body as { run: { id: string } }).run.id,
      );
    });

    it('requires ADMIN for run history, detail, and manual trigger endpoints', async () => {
      const paths = [
        ['GET', '/admin/cod-reconciliation/runs'],
        ['GET', `/admin/cod-reconciliation/runs/${randomUUID()}`],
        ['POST', '/admin/cod-reconciliation/runs/trigger'],
      ] as const;

      for (const [method, path] of paths) {
        const unauthenticated = await api(
          method,
          path,
          method === 'POST' ? { body: {} } : {},
        );
        const nonAdmin = await api(
          method,
          path,
          method === 'POST'
            ? { user: customerId, body: {} }
            : { user: customerId },
        );
        expect(unauthenticated.status).toBe(HttpStatus.UNAUTHORIZED);
        expect(nonAdmin.status).toBe(HttpStatus.FORBIDDEN);
      }
    });
  });

  describe('authorisation', () => {
    const endpoints = [
      '/admin/cod-reconciliation',
      '/admin/cod-reconciliation/summary',
      '/admin/cod-reconciliation/uncollected',
      '/admin/cod-reconciliation/discrepancies',
      '/admin/cod-reconciliation/by-staff',
      '/admin/cod-reconciliation/by-period',
    ] as const;

    it.each(endpoints)('admits an administrator to %s', async (path) => {
      const res = await adminGet(path, { orderNumber: corePrefix });
      expect(res.status).toBe(HttpStatus.OK);
    });

    it.each(endpoints)('returns 401 without a token for %s', async (path) => {
      const res = await api('GET', path, {
        query: { orderNumber: corePrefix },
      });
      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it.each(endpoints)('returns 403 for a customer on %s', async (path) => {
      const res = await api('GET', path, {
        user: customerId,
        query: { orderNumber: corePrefix },
      });
      expect(res.status).toBe(HttpStatus.FORBIDDEN);
    });

    it.each(endpoints)(
      'does not let a forged ADMIN claim bypass the database role on %s',
      async (path) => {
        const res = await api('GET', path, {
          token: issueToken(customerId, Role.ADMIN),
          query: { orderNumber: corePrefix },
        });
        expect(res.status).toBe(HttpStatus.FORBIDDEN);
      },
    );
  });

  describe('query validation', () => {
    const invalidQueries: Array<[string, Record<string, string>]> = [
      ['page below one', { page: '0' }],
      ['non-numeric page', { page: 'abc' }],
      ['limit above one hundred', { limit: '101' }],
      ['invalid start date', { startDate: 'not-a-date' }],
      ['invalid end date', { endDate: '2026-13-01' }],
      ['invalid staff id', { staffId: 'not-a-uuid' }],
      ['invalid order id', { orderId: 'not-a-uuid' }],
      ['invalid currency', { currency: 'US' }],
      ['invalid status', { status: 'REFUNDED' }],
      ['invalid period', { period: 'yearly' }],
      ['unknown filter', { unknownFilter: 'value' }],
      [
        'start date after end date',
        { startDate: '2026-02-09', endDate: '2026-02-02' },
      ],
    ];

    it.each(invalidQueries)('rejects %s', async (_label, query) => {
      const res = await adminGet('/admin/cod-reconciliation', {
        orderNumber: corePrefix,
        ...query,
      });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });
  });
});
