import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DeliveryStatus, Role } from '../src/generated/prisma/enums.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { DeliveryRepository } from '../src/delivery/repositories/delivery.repository.js';
import { ReconciliationRepository } from '../src/delivery/repositories/reconciliation.repository.js';
import { ReconciliationService } from '../src/delivery/reconciliation.service.js';

describe('ReconciliationRepository (PostgreSQL)', () => {
  const run = randomUUID().slice(0, 8);
  const codeRun = run.toUpperCase();
  const runIds: string[] = [];
  const orderIds: string[] = [];
  const userIds: string[] = [];

  let module: TestingModule;
  let prisma: PrismaService;
  let repository: ReconciliationRepository;
  let service: ReconciliationService;
  let customerId: string;
  let staffId: string;
  let managerId: string;
  let shippingProviderId: string;
  let codAreaId: string;
  let orderCounter = 0;

  const windowStart = new Date('2026-07-01T00:00:00.000Z');
  const windowEnd = new Date('2026-07-02T00:00:00.000Z');

  const createUser = async (label: string, role: Role): Promise<string> => {
    const id = randomUUID();
    await prisma.user.create({
      data: {
        id,
        firstName: 'Reconciliation',
        lastName: `${label}-${run}`,
        email: `reconciliation-${run}-${label}-${id.slice(0, 8)}@example.test`,
        passwordHash: 'not-used-by-integration-tests',
        status: 'ACTIVE',
        role,
      },
    });
    userIds.push(id);
    return id;
  };

  const createDeliveredOrder = async (
    deliveredAt: Date,
    options: { amount: string; currency: string; collected?: boolean },
  ): Promise<string> => {
    orderCounter += 1;
    const order = await prisma.order.create({
      data: {
        userId: customerId,
        orderNumber: `RR-${run}-${orderCounter}`,
        status: 'DELIVERED',
        subtotal: options.amount,
        shippingFee: '0.00',
        discountAmount: '0.00',
        totalAmount: options.amount,
        currency: options.currency,
        paymentMethod: 'COD',
        shippingProviderId,
        shippingProviderCode: `RR-${codeRun}`,
        shippingProviderName: `Reconciliation Provider ${run}`,
        codAreaId,
        codAreaCode: `RR-${codeRun}`,
        codAreaName: `Reconciliation Area ${run}`,
        shippingRecipientName: 'Repository Integration',
        shippingPhone: '+15555550123',
        shippingAddressLine1: '1 Repository Test Way',
        shippingCity: 'Testville',
        shippingCountryCode: 'US',
      },
      select: { id: true },
    });
    orderIds.push(order.id);

    await prisma.deliveryAssignment.create({
      data: {
        orderId: order.id,
        deliveryStaffId: staffId,
        assignedById: managerId,
        status: DeliveryStatus.DELIVERED,
        assignedAt: new Date(deliveredAt.getTime() - 60_000),
        deliveredAt,
        endedAt: deliveredAt,
      },
    });

    if (options.collected) {
      await prisma.codCollection.create({
        data: {
          orderId: order.id,
          collectedById: staffId,
          amount: options.amount,
          currency: options.currency,
        },
      });
    }

    return order.id;
  };

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set for repository integration tests');
    }
    if (!/(^|[_-])test($|[_-])/i.test(new URL(process.env.DATABASE_URL).pathname)) {
      throw new Error('Refusing to run repository integration tests outside a test database');
    }

    module = await Test.createTestingModule({
      providers: [
        PrismaService,
        DeliveryRepository,
        ReconciliationRepository,
        ReconciliationService,
      ],
    }).compile();
    prisma = module.get(PrismaService);
    repository = module.get(ReconciliationRepository);
    service = module.get(ReconciliationService);

    customerId = await createUser('customer', Role.CUSTOMER);
    staffId = await createUser('staff', Role.DELIVERY_STAFF);
    managerId = await createUser('manager', Role.DELIVERY_MANAGER);

    const provider = await prisma.shippingProvider.create({
      data: {
        code: `RR-${codeRun}`,
        name: `Reconciliation Provider ${run}`,
        baseFee: '0.00',
        supportsCod: true,
        isActive: true,
      },
      select: { id: true },
    });
    shippingProviderId = provider.id;

    const area = await prisma.codArea.create({
      data: {
        code: `RR-${codeRun}`,
        name: `Reconciliation Area ${run}`,
        codEnabled: true,
      },
      select: { id: true },
    });
    codAreaId = area.id;
  });

  afterAll(async () => {
    if (orderIds.length > 0) {
      await prisma.codCollection.deleteMany({
        where: { orderId: { in: orderIds } },
      });
      await prisma.deliveryAssignment.deleteMany({
        where: { orderId: { in: orderIds } },
      });
      await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    if (runIds.length > 0) {
      await prisma.codReconciliationRun.deleteMany({
        where: { id: { in: runIds } },
      });
    }
    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    if (shippingProviderId) {
      await prisma.shippingProvider.deleteMany({
        where: { id: shippingProviderId },
      });
    }
    if (codAreaId) {
      await prisma.codArea.deleteMany({ where: { id: codAreaId } });
    }
    await prisma?.$disconnect();
    await module?.close();
  });

  it('creates only one active run when concurrent callers share a window', async () => {
    const start = new Date('2026-08-01T00:00:00.000Z');
    const end = new Date('2026-08-02T00:00:00.000Z');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => repository.createRun('cron', start, end)),
    );
    const created = results.filter((result) => result !== null);
    expect(created).toHaveLength(1);
    runIds.push(created[0].id);
  });

  it('allows a failed run to be retried for the same window and trigger', async () => {
    const start = new Date('2026-08-03T00:00:00.000Z');
    const end = new Date('2026-08-04T00:00:00.000Z');
    const failedRun = await repository.createRun('manual', start, end);
    expect(failedRun).not.toBeNull();
    runIds.push(failedRun!.id);

    await repository.markRunFailed(failedRun!.id, 'temporary failure');
    const retry = await repository.createRun('manual', start, end);

    expect(retry).not.toBeNull();
    expect(retry).toMatchObject({ status: 'running', triggerType: 'manual' });
    runIds.push(retry!.id);
  });

  it('completes a run once and prevents further completion or failure writes', async () => {
    const runRecord = await repository.createRun(
      'manual',
      new Date('2026-08-05T00:00:00.000Z'),
      new Date('2026-08-06T00:00:00.000Z'),
    );
    expect(runRecord).not.toBeNull();
    runIds.push(runRecord!.id);

    const completed = await repository.completeRun(runRecord!.id, {
      processedCount: 12,
      matchedCount: 8,
      discrepancyCount: 3,
      uncollectedCount: 1,
    });
    expect(completed).toMatchObject({
      status: 'completed',
      processedCount: 12,
      matchedCount: 8,
      discrepancyCount: 3,
      uncollectedCount: 1,
    });
    await expect(
      repository.completeRun(runRecord!.id, {
        processedCount: 99,
        matchedCount: 99,
        discrepancyCount: 0,
        uncollectedCount: 0,
      }),
    ).rejects.toThrow();
    await expect(
      repository.markRunFailed(runRecord!.id, 'late error'),
    ).rejects.toThrow();

    await expect(repository.findRunById(runRecord!.id)).resolves.toMatchObject({
      status: 'completed',
      processedCount: 12,
      matchedCount: 8,
      discrepancyCount: 3,
      uncollectedCount: 1,
      errorMessage: null,
    });
  });

  it('uses a UTC half-open window and leaves all financial rows unchanged', async () => {
    const beforeId = await createDeliveredOrder(
      new Date(windowStart.getTime() - 1),
      { amount: '1.01', currency: 'USD' },
    );
    const startId = await createDeliveredOrder(windowStart, {
      amount: '12.34',
      currency: 'USD',
      collected: true,
    });
    const insideId = await createDeliveredOrder(
      new Date('2026-07-01T12:30:00.000Z'),
      { amount: '1250.45', currency: 'KHR' },
    );
    const endId = await createDeliveredOrder(windowEnd, {
      amount: '9.99',
      currency: 'USD',
    });
    const ids = [beforeId, startId, insideId, endId];

    const financialSnapshot = async () => {
      const [orders, payments, collections] = await Promise.all([
        prisma.order.findMany({
          where: { id: { in: ids } },
          orderBy: { id: 'asc' },
          select: { id: true, status: true, totalAmount: true, currency: true },
        }),
        prisma.payment.findMany({
          where: { orderId: { in: ids } },
          orderBy: { id: 'asc' },
          select: { id: true, status: true, amount: true, currency: true },
        }),
        prisma.codCollection.findMany({
          where: { orderId: { in: ids } },
          orderBy: { id: 'asc' },
          select: { id: true, orderId: true, amount: true, currency: true },
        }),
      ]);

      return {
        orders: orders.map((order) => ({
          ...order,
          totalAmount: order.totalAmount.toString(),
        })),
        payments: payments.map((payment) => ({
          ...payment,
          amount: payment.amount.toString(),
        })),
        collections: collections.map((collection) => ({
          ...collection,
          amount: collection.amount.toString(),
        })),
      };
    };

    const before = await financialSnapshot();
    const result = await repository.findReconciliationData(windowStart, windowEnd);
    const after = await financialSnapshot();

    expect(result.map((record) => record.orderId).sort()).toEqual(
      [startId, insideId].sort(),
    );
    expect(result.find((record) => record.orderId === startId)?.expectedAmount.toString()).toBe('12.34');
    expect(result.find((record) => record.orderId === insideId)?.expectedAmount.toString()).toBe('1250.45');
    expect(result.find((record) => record.orderId === startId)?.collectedAmount?.toString()).toBe('12.34');
    expect(result.map((record) => record.currency).sort()).toEqual(['KHR', 'USD']);

    const execution = await service.reconcileWindow(
      windowStart,
      windowEnd,
      'manual',
    );
    expect(execution).not.toBeNull();
    runIds.push(execution!.run.id);
    expect(execution!.counters).toEqual({
      processedCount: 2,
      matchedCount: 1,
      discrepancyCount: 1,
      uncollectedCount: 1,
    });
    expect(execution!.discrepancyBreakdown).toEqual({
      missingCollections: 1,
      amountMismatches: 0,
      currencyMismatches: 0,
    });
    expect(execution!.run).toMatchObject({
      status: 'completed',
      processedCount: 2,
      matchedCount: 1,
      discrepancyCount: 1,
      uncollectedCount: 1,
    });
    expect(after).toEqual(before);
    expect(await financialSnapshot()).toEqual(before);
  });

  it('retrieves a run and returns paginated run history', async () => {
    const start = new Date('2026-08-07T00:00:00.000Z');
    const end = new Date('2026-08-08T00:00:00.000Z');
    const created = await repository.createRun('manual', start, end);
    expect(created).not.toBeNull();
    runIds.push(created!.id);

    await expect(repository.findRunById(created!.id)).resolves.toMatchObject({
      id: created!.id,
      status: 'running',
    });
    const history = await repository.findRunHistory({ page: 1, limit: 2 });
    expect(history.items.length).toBeLessThanOrEqual(2);
    expect(history.total).toBeGreaterThanOrEqual(history.items.length);
    expect(history.totalPages).toBe(Math.ceil(history.total / history.limit));
  });
});
