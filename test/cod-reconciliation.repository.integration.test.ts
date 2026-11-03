import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../src/generated/prisma/client.js';
import { DeliveryStatus, Role } from '../src/generated/prisma/enums.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  DeliveryRepository,
  type CodReconciliationRecordItem,
} from '../src/delivery/repositories/delivery.repository.js';
import {
  RECONCILIATION_STALE_RUN_ERROR,
  RECONCILIATION_STALE_RUN_THRESHOLD_MS,
  ReconciliationRepository,
} from '../src/delivery/repositories/reconciliation.repository.js';
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
  let collectorId: string;
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
    options: {
      amount: string;
      currency: string;
      collected?: boolean;
      collectorId?: string;
    },
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
          collectedById: options.collectorId ?? staffId,
          amount: options.amount,
          currency: options.currency,
        },
      });
    }

    return order.id;
  };

  const snapshotRecord = (
    overrides: Partial<CodReconciliationRecordItem> = {},
  ): CodReconciliationRecordItem => {
    const orderId = overrides.orderId ?? randomUUID();
    return {
      orderId,
      orderNumber: `SNAP-${orderId.slice(0, 8)}`,
      orderStatus: 'DELIVERED',
      paymentMethod: 'COD',
      totalAmount: new Prisma.Decimal('10.00'),
      expectedAmount: new Prisma.Decimal('10.00'),
      currency: 'USD',
      collectedAmount: new Prisma.Decimal('10.00'),
      collectionCurrency: 'USD',
      collectionId: randomUUID(),
      collectedAt: new Date('2026-10-01T10:05:00.000Z'),
      collectedById: collectorId,
      collectedBy: {
        id: collectorId,
        firstName: 'Snapshot',
        lastName: 'Collector',
        email: `snapshot-collector-${run}@example.test`,
      },
      deliveryStaffId: staffId,
      deliveryStaff: {
        id: staffId,
        firstName: 'Snapshot',
        lastName: 'Courier',
        email: `snapshot-courier-${run}@example.test`,
      },
      deliveredAt: new Date('2026-10-01T10:00:00.000Z'),
      assignmentId: randomUUID(),
      discrepancy: false,
      discrepancyType: null,
      ...overrides,
    };
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
    collectorId = await createUser('collector', Role.DELIVERY_STAFF);
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
      await prisma.codReconciliationRunItem.deleteMany({
        where: { runId: { in: runIds } },
      });
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

  describe('snapshot persistence', () => {
    it('persists matched, amount, currency and missing branches with staff attribution', async () => {
      const start = new Date('2026-11-10T00:00:00.000Z');
      const end = new Date('2026-11-11T00:00:00.000Z');

      const matched = await createDeliveredOrder(
        new Date('2026-11-10T08:00:00.000Z'),
        { amount: '10.10', currency: 'USD', collected: true },
      );
      const amountMismatch = await createDeliveredOrder(
        new Date('2026-11-10T09:00:00.000Z'),
        { amount: '20.20', currency: 'USD' },
      );
      await prisma.codCollection.create({
        data: {
          orderId: amountMismatch,
          collectedById: staffId,
          amount: '19.19',
          currency: 'USD',
        },
      });
      const currencyMismatch = await createDeliveredOrder(
        new Date('2026-11-10T10:00:00.000Z'),
        { amount: '30.30', currency: 'USD' },
      );
      await prisma.codCollection.create({
        data: {
          orderId: currencyMismatch,
          collectedById: staffId,
          amount: '120000.00',
          currency: 'KHR',
        },
      });
      const missing = await createDeliveredOrder(
        new Date('2026-11-10T11:00:00.000Z'),
        { amount: '40.40', currency: 'USD' },
      );
      const collectedByOther = await createDeliveredOrder(
        new Date('2026-11-10T12:00:00.000Z'),
        {
          amount: '50.50',
          currency: 'USD',
          collected: true,
          collectorId,
        },
      );

      const execution = await service.reconcileWindow(start, end, 'manual');
      expect(execution).not.toBeNull();
      runIds.push(execution!.run.id);
      expect(execution!.counters).toEqual({
        processedCount: 5,
        matchedCount: 2,
        discrepancyCount: 3,
        uncollectedCount: 1,
      });

      const detail = await repository.findRunSnapshot(execution!.run.id, {
        page: 1,
        limit: 20,
      });
      expect(detail?.run.snapshotsWritten).toBe(true);
      expect(detail?.total).toBe(5);
      expect(detail?.items).toHaveLength(5);

      const byOrderId = new Map(
        detail!.items.map((item) => [item.orderId, item]),
      );
      expect(byOrderId.get(matched)).toMatchObject({
        orderNumber: expect.stringContaining('RR-'),
        orderStatus: 'DELIVERED',
        paymentMethod: 'COD',
        currency: 'USD',
        discrepancy: false,
        discrepancyType: null,
        deliveryStaffId: staffId,
        collectedById: staffId,
      });
      expect(byOrderId.get(matched)?.expectedAmount.toFixed(2)).toBe('10.10');
      expect(byOrderId.get(matched)?.collectedAmount?.toFixed(2)).toBe('10.10');
      expect(byOrderId.get(matched)?.assignmentId).toBeTruthy();
      expect(byOrderId.get(amountMismatch)).toMatchObject({
        discrepancy: true,
        discrepancyType: 'amount-mismatch',
      });
      expect(byOrderId.get(currencyMismatch)).toMatchObject({
        discrepancy: true,
        discrepancyType: 'currency-mismatch',
        currency: 'USD',
        collectionCurrency: 'KHR',
      });
      expect(byOrderId.get(missing)).toMatchObject({
        discrepancy: true,
        discrepancyType: 'missing-collection',
        collectedAmount: null,
        collectedById: null,
        collectionId: null,
      });
      expect(byOrderId.get(collectedByOther)).toMatchObject({
        discrepancy: false,
        deliveryStaffId: staffId,
        deliveryStaffFirstName: expect.any(String),
        deliveryStaffLastName: expect.any(String),
        deliveryStaffEmail: expect.any(String),
        collectedById: collectorId,
        collectedByFirstName: 'Reconciliation',
        collectedByLastName: expect.stringContaining('collector-'),
      });
      expect(byOrderId.get(collectedByOther)?.deliveryStaffId).not.toBe(
        byOrderId.get(collectedByOther)?.collectedById,
      );

      const summaries = new Map(
        detail!.summaryByCurrency.map((entry) => [entry.currency, entry]),
      );
      expect(summaries.get('USD')).toMatchObject({
        expectedCount: 5,
        matchedCount: 2,
        discrepancyCount: 3,
        collectedCount: 3,
      });
      expect(summaries.get('USD')?.expectedAmount.toFixed(2)).toBe('151.50');
      expect(summaries.get('USD')?.collectedAmount.toFixed(2)).toBe('79.79');
      expect(summaries.get('KHR')).toMatchObject({
        expectedCount: 0,
        matchedCount: 0,
        discrepancyCount: 0,
        collectedCount: 1,
      });
      expect(summaries.get('KHR')?.expectedAmount.toFixed(2)).toBe('0.00');
      expect(summaries.get('KHR')?.collectedAmount.toFixed(2)).toBe('120000.00');

      // Live financial rows may change later; the persisted snapshot must not.
      await prisma.order.update({
        where: { id: matched },
        data: {
          subtotal: '999.99',
          totalAmount: '999.99',
          status: 'CANCELLED',
          paymentMethod: 'ABA_PAYWAY',
          codAreaId: null,
          codAreaCode: null,
          codAreaName: null,
        },
      });
      await prisma.codCollection.update({
        where: { orderId: matched },
        data: { amount: '1.00', currency: 'KHR' },
      });

      const afterChange = await repository.findRunSnapshot(execution!.run.id, {
        page: 1,
        limit: 20,
      });
      const matchedAfter = afterChange!.items.find(
        (item) => item.orderId === matched,
      );
      expect(matchedAfter).toMatchObject({
        orderStatus: 'DELIVERED',
        paymentMethod: 'COD',
        currency: 'USD',
      });
      expect(matchedAfter?.expectedAmount.toFixed(2)).toBe('10.10');
      expect(matchedAfter?.collectedAmount?.toFixed(2)).toBe('10.10');
      expect(matchedAfter?.collectionCurrency).toBe('USD');
      expect(afterChange?.summaryByCurrency).toEqual(detail?.summaryByCurrency);
    });

    it('completes a zero-order window with snapshotsWritten true and no items', async () => {
      const start = new Date('2026-11-11T00:00:00.000Z');
      const end = new Date('2026-11-12T00:00:00.000Z');
      const created = await repository.createRun('manual', start, end);
      expect(created).not.toBeNull();
      runIds.push(created!.id);

      await expect(
        repository.completeRun(created!.id, {
          processedCount: 0,
          matchedCount: 0,
          discrepancyCount: 0,
          uncollectedCount: 0,
        }),
      ).resolves.toMatchObject({ snapshotsWritten: true });

      const detail = await repository.findRunSnapshot(created!.id, {
        page: 1,
        limit: 20,
      });
      expect(detail).toMatchObject({
        run: { snapshotsWritten: true },
        items: [],
        total: 0,
        summaryByCurrency: [],
      });
    });

    it('treats snapshotsWritten false as the only legacy snapshot authority', async () => {
      const created = await repository.createRun(
        'manual',
        new Date('2026-11-12T00:00:00.000Z'),
        new Date('2026-11-13T00:00:00.000Z'),
      );
      expect(created).not.toBeNull();
      runIds.push(created!.id);

      await prisma.codReconciliationRun.update({
        where: { id: created!.id },
        data: { status: 'completed', completedAt: new Date() },
      });
      // Simulate a stray row: item count must never be used to infer a snapshot.
      await prisma.codReconciliationRunItem.create({
        data: {
          runId: created!.id,
          orderId: randomUUID(),
          currency: 'USD',
          expectedAmount: '5.00',
        },
      });

      const detail = await repository.findRunSnapshot(created!.id, {
        page: 1,
        limit: 20,
      });
      expect(detail).toMatchObject({
        run: { snapshotsWritten: false, status: 'completed' },
        items: [],
        total: 0,
        summaryByCurrency: [],
      });
    });

    it('rolls back completion when snapshot insertion fails', async () => {
      const created = await repository.createRun(
        'manual',
        new Date('2026-11-13T00:00:00.000Z'),
        new Date('2026-11-14T00:00:00.000Z'),
      );
      expect(created).not.toBeNull();
      runIds.push(created!.id);

      await expect(
        repository.completeRun(
          created!.id,
          {
            processedCount: 1,
            matchedCount: 1,
            discrepancyCount: 0,
            uncollectedCount: 0,
          },
          [
            snapshotRecord({
              orderNumber: `TOO-LONG-${'x'.repeat(40)}`,
            }),
          ],
        ),
      ).rejects.toThrow();

      await expect(repository.findRunById(created!.id)).resolves.toMatchObject({
        status: 'running',
        snapshotsWritten: false,
        processedCount: 0,
      });
      await expect(
        prisma.codReconciliationRunItem.count({
          where: { runId: created!.id },
        }),
      ).resolves.toBe(0);
    });

    it('does not persist snapshot rows when the completion transition fails', async () => {
      const created = await repository.createRun(
        'manual',
        new Date('2026-11-14T00:00:00.000Z'),
        new Date('2026-11-15T00:00:00.000Z'),
      );
      expect(created).not.toBeNull();
      runIds.push(created!.id);
      await prisma.codReconciliationRun.update({
        where: { id: created!.id },
        data: { status: 'completed', completedAt: new Date() },
      });

      await expect(
        repository.completeRun(
          created!.id,
          {
            processedCount: 1,
            matchedCount: 1,
            discrepancyCount: 0,
            uncollectedCount: 0,
          },
          [snapshotRecord()],
        ),
      ).rejects.toThrow(/already completed/);

      await expect(
        prisma.codReconciliationRunItem.count({
          where: { runId: created!.id },
        }),
      ).resolves.toBe(0);
    });

    it('lets only one concurrent completion persist a snapshot', async () => {
      const created = await repository.createRun(
        'manual',
        new Date('2026-11-16T00:00:00.000Z'),
        new Date('2026-11-17T00:00:00.000Z'),
      );
      expect(created).not.toBeNull();
      runIds.push(created!.id);

      const first = snapshotRecord({
        orderId: randomUUID(),
        orderNumber: 'CONCURRENT-1',
      });
      const second = snapshotRecord({
        orderId: randomUUID(),
        orderNumber: 'CONCURRENT-2',
      });
      const counters = {
        processedCount: 1,
        matchedCount: 1,
        discrepancyCount: 0,
        uncollectedCount: 0,
      };

      const results = await Promise.allSettled([
        repository.completeRun(created!.id, counters, [first]),
        repository.completeRun(created!.id, counters, [second]),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

      const items = await prisma.codReconciliationRunItem.findMany({
        where: { runId: created!.id },
      });
      expect(items).toHaveLength(1);
      expect([first.orderId, second.orderId]).toContain(items[0]!.orderId);
      await expect(repository.findRunById(created!.id)).resolves.toMatchObject({
        status: 'completed',
        snapshotsWritten: true,
      });
    });

    it('paginates deterministically and summarises every row independently of the page', async () => {
      const created = await repository.createRun(
        'manual',
        new Date('2026-11-15T00:00:00.000Z'),
        new Date('2026-11-16T00:00:00.000Z'),
      );
      expect(created).not.toBeNull();
      runIds.push(created!.id);

      const firstDeliveredAt = new Date('2026-11-15T08:00:00.000Z');
      const secondDeliveredAt = new Date('2026-11-15T09:00:00.000Z');
      const orderA = randomUUID();
      const orderB = randomUUID();
      const orderC = randomUUID();
      const orderD = randomUUID();

      await repository.completeRun(
        created!.id,
        {
          processedCount: 4,
          matchedCount: 3,
          discrepancyCount: 1,
          uncollectedCount: 1,
        },
        [
          snapshotRecord({
            orderId: orderA,
            orderNumber: 'B',
            deliveredAt: firstDeliveredAt,
            expectedAmount: new Prisma.Decimal('10.00'),
            collectedAmount: new Prisma.Decimal('10.00'),
            collectionCurrency: 'USD',
          }),
          snapshotRecord({
            orderId: orderB,
            orderNumber: 'A',
            deliveredAt: firstDeliveredAt,
            expectedAmount: new Prisma.Decimal('20.00'),
            collectedAmount: new Prisma.Decimal('120000.00'),
            collectionCurrency: 'KHR',
            discrepancy: true,
            discrepancyType: 'currency-mismatch',
          }),
          snapshotRecord({
            orderId: orderC,
            orderNumber: null,
            deliveredAt: secondDeliveredAt,
            expectedAmount: new Prisma.Decimal('30.00'),
            collectedAmount: null,
            collectionCurrency: null,
            collectionId: null,
            collectedAt: null,
            collectedById: null,
            collectedBy: null,
            discrepancy: true,
            discrepancyType: 'missing-collection',
          }),
          snapshotRecord({
            orderId: orderD,
            orderNumber: 'A',
            deliveredAt: null,
            currency: 'KHR',
            expectedAmount: new Prisma.Decimal('40000.00'),
            collectedAmount: new Prisma.Decimal('40000.00'),
            collectionCurrency: 'KHR',
          }),
        ],
      );

      const firstPage = await repository.findRunSnapshot(created!.id, {
        page: 1,
        limit: 2,
      });
      const secondPage = await repository.findRunSnapshot(created!.id, {
        page: 2,
        limit: 2,
      });

      expect(firstPage?.total).toBe(4);
      expect(firstPage?.items.map((item) => item.orderId)).toEqual([
        orderB,
        orderA,
      ]);
      expect(secondPage?.items.map((item) => item.orderId)).toEqual([
        orderC,
        orderD,
      ]);

      const summaries = new Map(
        firstPage!.summaryByCurrency.map((entry) => [entry.currency, entry]),
      );
      expect(summaries.get('USD')).toMatchObject({
        expectedCount: 3,
        matchedCount: 1,
        discrepancyCount: 2,
        collectedCount: 1,
      });
      expect(summaries.get('USD')?.expectedAmount.toString()).toBe('60');
      expect(summaries.get('USD')?.collectedAmount.toString()).toBe('10');
      expect(summaries.get('KHR')).toMatchObject({
        expectedCount: 1,
        matchedCount: 1,
        discrepancyCount: 0,
        collectedCount: 2,
      });
      expect(summaries.get('KHR')?.expectedAmount.toString()).toBe('40000');
      expect(summaries.get('KHR')?.collectedAmount.toString()).toBe('160000');
      expect(secondPage?.summaryByCurrency).toEqual(
        firstPage?.summaryByCurrency,
      );
    });
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

  it('serializes concurrent recovery claims for the same daily window', async () => {
    const start = new Date('2026-09-10T00:00:00.000Z');
    const end = new Date('2026-09-11T00:00:00.000Z');

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        repository.claimRecoveryWindow(start, end),
      ),
    );

    const claimed = results.filter((result) => result.outcome === 'claimed');
    expect(claimed).toHaveLength(1);
    expect(
      results.filter((result) => result.outcome === 'busy'),
    ).toHaveLength(5);
    expect(claimed[0]!.run).toMatchObject({
      triggerType: 'cron',
      status: 'running',
      windowStart: start,
      windowEnd: end,
    });
    runIds.push(claimed[0]!.run!.id);
  });

  it('serializes concurrent manual and recovery claims for the same window', async () => {
    const start = new Date('2026-09-11T00:00:00.000Z');
    const end = new Date('2026-09-12T00:00:00.000Z');

    const results = await Promise.all([
      repository.claimManualWindow(start, end),
      repository.claimRecoveryWindow(start, end),
    ]);

    const claimed = results.filter((result) => result.outcome === 'claimed');
    const busy = results.filter((result) => result.outcome === 'busy');
    expect(claimed).toHaveLength(1);
    expect(busy).toHaveLength(1);
    runIds.push(claimed[0]!.run!.id);
  });

  it('fails stale running runs using database time and claims a new attempt', async () => {
    const start = new Date('2026-09-12T00:00:00.000Z');
    const end = new Date('2026-09-13T00:00:00.000Z');
    const staleRun = await repository.createRun('cron', start, end);
    expect(staleRun).not.toBeNull();
    runIds.push(staleRun!.id);

    await prisma.codReconciliationRun.update({
      where: { id: staleRun!.id },
      data: {
        startedAt: new Date(
          Date.now() - RECONCILIATION_STALE_RUN_THRESHOLD_MS - 60_000,
        ),
      },
    });

    const claim = await repository.claimRecoveryWindow(start, end);
    expect(claim.outcome).toBe('claimed');
    expect(claim.run).toMatchObject({
      triggerType: 'cron',
      status: 'running',
      windowStart: start,
      windowEnd: end,
    });
    runIds.push(claim.run!.id);

    await expect(repository.findRunById(staleRun!.id)).resolves.toMatchObject({
      status: 'failed',
      errorMessage: RECONCILIATION_STALE_RUN_ERROR,
      completedAt: expect.any(Date),
    });
  });

  it('treats a completed run after windowEnd as coverage for any trigger', async () => {
    const start = new Date('2026-09-13T00:00:00.000Z');
    const end = new Date('2026-09-14T00:00:00.000Z');
    const completed = await repository.createRun('manual', start, end);
    expect(completed).not.toBeNull();
    runIds.push(completed!.id);
    await repository.completeRun(completed!.id, {
      processedCount: 0,
      matchedCount: 0,
      discrepancyCount: 0,
      uncollectedCount: 0,
    });

    await expect(
      repository.claimRecoveryWindow(start, end),
    ).resolves.toMatchObject({
      outcome: 'covered',
      run: { id: completed!.id, triggerType: 'manual', status: 'completed' },
    });
  });

  it('does not treat a run completed before windowEnd as coverage', async () => {
    const start = new Date('2099-01-01T00:00:00.000Z');
    const end = new Date('2099-01-02T00:00:00.000Z');
    const premature = await repository.createRun('manual', start, end);
    expect(premature).not.toBeNull();
    runIds.push(premature!.id);
    await repository.completeRun(premature!.id, {
      processedCount: 0,
      matchedCount: 0,
      discrepancyCount: 0,
      uncollectedCount: 0,
    });

    const claim = await repository.claimRecoveryWindow(start, end);
    expect(claim.outcome).toBe('claimed');
    expect(claim.run).toMatchObject({ triggerType: 'cron', status: 'running' });
    runIds.push(claim.run!.id);
  });

  it('does not treat a partial manual window as daily coverage', async () => {
    const start = new Date('2026-09-14T00:00:00.000Z');
    const end = new Date('2026-09-15T00:00:00.000Z');
    const partial = await repository.createRun(
      'manual',
      start,
      new Date('2026-09-14T12:00:00.000Z'),
    );
    expect(partial).not.toBeNull();
    runIds.push(partial!.id);
    await repository.completeRun(partial!.id, {
      processedCount: 0,
      matchedCount: 0,
      discrepancyCount: 0,
      uncollectedCount: 0,
    });

    const claim = await repository.claimRecoveryWindow(start, end);
    expect(claim.outcome).toBe('claimed');
    expect(claim.run).toMatchObject({ triggerType: 'cron', status: 'running' });
    runIds.push(claim.run!.id);
  });

  it('keeps manual rechecks available after a completed cron run', async () => {
    const start = new Date('2026-09-15T00:00:00.000Z');
    const end = new Date('2026-09-16T00:00:00.000Z');
    const completedCron = await repository.createRun('cron', start, end);
    expect(completedCron).not.toBeNull();
    runIds.push(completedCron!.id);
    await repository.completeRun(completedCron!.id, {
      processedCount: 0,
      matchedCount: 0,
      discrepancyCount: 0,
      uncollectedCount: 0,
    });

    const recheck = await repository.claimManualWindow(start, end);
    expect(recheck.outcome).toBe('claimed');
    expect(recheck.run).toMatchObject({
      triggerType: 'manual',
      status: 'running',
    });
    runIds.push(recheck.run!.id);

    await repository.completeRun(recheck.run!.id, {
      processedCount: 0,
      matchedCount: 0,
      discrepancyCount: 0,
      uncollectedCount: 0,
    });
    await expect(
      repository.claimManualWindow(start, end),
    ).resolves.toMatchObject({ outcome: 'duplicate', run: null });
  });

  it('recovers multiple missed UTC days oldest-first and is idempotent', async () => {
    const now = new Date('2026-09-20T06:00:00.000Z');
    const first = await service.recoverMissedUtcDays(now, 2);

    expect(first).toEqual({
      windowsScanned: 2,
      recovered: 2,
      skipped: 0,
      failed: 0,
    });

    const runs = await prisma.codReconciliationRun.findMany({
      where: {
        triggerType: 'cron',
        windowStart: {
          in: [
            new Date('2026-09-18T00:00:00.000Z'),
            new Date('2026-09-19T00:00:00.000Z'),
          ],
        },
      },
      orderBy: { windowStart: 'asc' },
    });
    expect(runs).toHaveLength(2);
    expect(runs.map((row) => row.windowStart.toISOString())).toEqual([
      '2026-09-18T00:00:00.000Z',
      '2026-09-19T00:00:00.000Z',
    ]);
    expect(runs.every((row) => row.status === 'completed')).toBe(true);
    runIds.push(...runs.map((row) => row.id));

    await expect(service.recoverMissedUtcDays(now, 2)).resolves.toEqual({
      windowsScanned: 2,
      recovered: 0,
      skipped: 2,
      failed: 0,
    });
  });
});
