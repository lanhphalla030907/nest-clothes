import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { Mock } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import type {
  CodReconciliationRun,
  CodReconciliationRunItem,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  DeliveryRepository,
  type CodReconciliationRecordItem,
} from './delivery.repository.js';
import {
  RECONCILIATION_STALE_RUN_ERROR,
  RECONCILIATION_STALE_RUN_THRESHOLD_MS,
  ReconciliationRepository,
} from './reconciliation.repository.js';

describe('ReconciliationRepository', () => {
  let repository: ReconciliationRepository;
  let prisma: {
    $queryRaw: Mock;
    $transaction: Mock;
    codReconciliationRun: {
      findUnique: Mock;
      findMany: Mock;
      count: Mock;
      updateMany: Mock;
    };
  };
  let transactionClient: {
    $queryRaw: Mock;
    $executeRaw: Mock;
    codReconciliationRun: {
      findMany: Mock;
      findUnique: Mock;
      count: Mock;
      updateMany: Mock;
    };
    codReconciliationRunItem: {
      findMany: Mock;
      count: Mock;
      groupBy: Mock;
      createMany: Mock;
    };
  };
  let deliveryRepository: {
    findCodReconciliationRecords: Mock;
  };

  const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const windowStart = new Date('2026-10-01T00:00:00.000Z');
  const windowEnd = new Date('2026-10-02T00:00:00.000Z');

  const createRun = (
    overrides: Partial<CodReconciliationRun> = {},
  ): CodReconciliationRun => ({
    id: runId,
    triggerType: 'manual',
    status: 'running',
    windowStart,
    windowEnd,
    processedCount: 0,
    matchedCount: 0,
    discrepancyCount: 0,
    uncollectedCount: 0,
    snapshotsWritten: false,
    errorMessage: null,
    startedAt: windowStart,
    completedAt: null,
    createdAt: windowStart,
    ...overrides,
  });

  const snapshotRecord = (
    discrepancy: boolean,
    discrepancyType: CodReconciliationRecordItem['discrepancyType'],
  ): CodReconciliationRecordItem => ({
    orderId: randomUUID(),
    orderNumber: 'ORDER-1',
    orderStatus: 'DELIVERED',
    paymentMethod: 'COD',
    totalAmount: new Prisma.Decimal('10.00'),
    expectedAmount: new Prisma.Decimal('10.00'),
    currency: 'USD',
    collectedAmount: new Prisma.Decimal('10.00'),
    collectionCurrency: 'USD',
    collectionId: randomUUID(),
    collectedAt: windowStart,
    collectedById: randomUUID(),
    collectedBy: {
      id: randomUUID(),
      firstName: 'Collector',
      lastName: 'One',
      email: 'collector@example.test',
    },
    deliveryStaffId: randomUUID(),
    deliveryStaff: {
      id: randomUUID(),
      firstName: 'Courier',
      lastName: 'One',
      email: 'courier@example.test',
    },
    deliveredAt: windowStart,
    assignmentId: randomUUID(),
    discrepancy,
    discrepancyType,
  });

  beforeEach(async () => {
    transactionClient = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $executeRaw: vi.fn().mockResolvedValue(1),
      codReconciliationRun: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        count: vi.fn(),
        updateMany: vi.fn(),
      },
      codReconciliationRunItem: {
        findMany: vi.fn(),
        count: vi.fn(),
        groupBy: vi.fn(),
        createMany: vi.fn(),
      },
    };
    prisma = {
      $queryRaw: vi.fn(),
      $transaction: vi.fn((callback: (tx: typeof transactionClient) => unknown) =>
        callback(transactionClient),
      ),
      codReconciliationRun: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        updateMany: vi.fn(),
      },
    };
    deliveryRepository = {
      findCodReconciliationRecords: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReconciliationRepository,
        { provide: PrismaService, useValue: prisma },
        { provide: DeliveryRepository, useValue: deliveryRepository },
      ],
    }).compile();

    repository = module.get(ReconciliationRepository);
  });

  it('creates a run using the partial unique index conflict target', async () => {
    const created = createRun();
    prisma.$queryRaw.mockResolvedValueOnce([created]);

    await expect(
      repository.createRun('manual', windowStart, windowEnd),
    ).resolves.toEqual(created);

    const [query, ...values] = prisma.$queryRaw.mock.calls[0];
    expect(query.join(' ')).toContain('ON CONFLICT');
    expect(query.join(' ')).toContain('"status" <> \'failed\'');
    expect(values).toEqual([expect.any(String), 'manual', windowStart, windowEnd]);
  });

  it('returns null when the database partial unique index rejects a concurrent run', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([]);

    await expect(
      repository.createRun('cron', windowStart, windowEnd),
    ).resolves.toBeNull();
  });

  it('returns a run by id and paginates history deterministically', async () => {
    const run = createRun();
    prisma.codReconciliationRun.findUnique.mockResolvedValueOnce(run);
    await expect(repository.findRunById(runId)).resolves.toEqual(run);

    const txClient = {
      codReconciliationRun: {
        findMany: vi.fn().mockResolvedValue([run]),
        count: vi.fn().mockResolvedValue(3),
      },
    };
    prisma.$transaction.mockImplementationOnce(
      (callback: (tx: typeof txClient) => unknown) => callback(txClient),
    );

    await expect(repository.findRunHistory({ page: 2, limit: 1 })).resolves
      .toEqual({
        items: [run],
        page: 2,
        limit: 1,
        total: 3,
        totalPages: 3,
      });
    expect(txClient.codReconciliationRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 1,
        take: 1,
      }),
    );
  });

  it('returns no snapshot items for a legacy run without touching snapshot rows', async () => {
    const legacy = createRun({ status: 'completed' });
    transactionClient.codReconciliationRun.findUnique.mockResolvedValueOnce(
      legacy,
    );

    await expect(
      repository.findRunSnapshot(runId, { page: 1, limit: 20 }),
    ).resolves.toEqual({
      run: legacy,
      items: [],
      total: 0,
      summaryByCurrency: [],
    });

    expect(transactionClient.codReconciliationRunItem.findMany).not.toHaveBeenCalled();
    expect(transactionClient.codReconciliationRunItem.groupBy).not.toHaveBeenCalled();
  });

  it('paginates snapshot items deterministically and aggregates all rows independently', async () => {
    const snapshotRun = createRun({
      status: 'completed',
      snapshotsWritten: true,
    });
    const item = {
      id: randomUUID(),
      runId,
      orderId: randomUUID(),
      orderNumber: 'ORDER-1',
      orderStatus: 'DELIVERED',
      paymentMethod: 'COD',
      currency: 'USD',
      expectedAmount: new Prisma.Decimal('40.04'),
      collectedAmount: new Prisma.Decimal('160000.00'),
      collectionCurrency: 'KHR',
      collectionId: randomUUID(),
      collectedAt: windowStart,
      collectedById: randomUUID(),
      collectedByFirstName: 'Collector',
      collectedByLastName: 'One',
      collectedByEmail: 'collector@example.test',
      deliveryStaffId: randomUUID(),
      deliveryStaffFirstName: 'Courier',
      deliveryStaffLastName: 'One',
      deliveryStaffEmail: 'courier@example.test',
      deliveredAt: windowStart,
      assignmentId: randomUUID(),
      discrepancy: true,
      discrepancyType: 'currency-mismatch',
      createdAt: windowStart,
    } satisfies CodReconciliationRunItem;

    transactionClient.codReconciliationRun.findUnique.mockResolvedValueOnce(
      snapshotRun,
    );
    transactionClient.codReconciliationRunItem.findMany.mockResolvedValueOnce([
      item,
    ]);
    transactionClient.codReconciliationRunItem.count.mockResolvedValueOnce(3);
    transactionClient.codReconciliationRunItem.groupBy
      .mockResolvedValueOnce([
        {
          currency: 'USD',
          _sum: { expectedAmount: new Prisma.Decimal('40.04') },
          _count: 2,
        },
      ])
      .mockResolvedValueOnce([
        {
          collectionCurrency: 'KHR',
          _sum: { collectedAmount: new Prisma.Decimal('160000.00') },
          _count: 1,
        },
        {
          collectionCurrency: 'USD',
          _sum: { collectedAmount: new Prisma.Decimal('10.00') },
          _count: 1,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          currency: 'USD',
          _count: 1,
        },
      ]);

    const result = await repository.findRunSnapshot(runId, {
      page: 2,
      limit: 1,
    });

    expect(transactionClient.codReconciliationRunItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { runId },
        skip: 1,
        take: 1,
        orderBy: [
          { deliveredAt: { sort: 'asc', nulls: 'last' } },
          { orderNumber: { sort: 'asc', nulls: 'last' } },
          { orderId: 'asc' },
          { id: 'asc' },
        ],
      }),
    );
    expect(result).toMatchObject({ total: 3 });
    expect(result?.items).toEqual([item]);
    expect(result?.summaryByCurrency).toEqual([
      {
        currency: 'KHR',
        expectedCount: 0,
        expectedAmount: new Prisma.Decimal(0),
        matchedCount: 0,
        discrepancyCount: 0,
        collectedCount: 1,
        collectedAmount: new Prisma.Decimal('160000.00'),
      },
      {
        currency: 'USD',
        expectedCount: 2,
        expectedAmount: new Prisma.Decimal('40.04'),
        matchedCount: 0,
        discrepancyCount: 1,
        collectedCount: 1,
        collectedAmount: new Prisma.Decimal('10.00'),
      },
    ]);
  });

  it('uses the existing financial reconciliation query for a repeatable UTC window', async () => {
    deliveryRepository.findCodReconciliationRecords.mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      limit: 500,
      totalPages: 0,
    });

    await expect(
      repository.findReconciliationData(windowStart, windowEnd),
    ).resolves.toEqual([]);

    expect(deliveryRepository.findCodReconciliationRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: windowStart,
        endDateExclusive: windowEnd,
        page: 1,
        limit: 500,
      }),
      expect.objectContaining({
        codReconciliationRun: expect.objectContaining({
          findMany: expect.any(Function),
          count: expect.any(Function),
        }),
      }),
    );
  });

  it('persists counters only while a run is running', async () => {
    const completed = createRun({
      status: 'completed',
      processedCount: 4,
      matchedCount: 2,
      discrepancyCount: 1,
      uncollectedCount: 1,
      completedAt: windowEnd,
    });
    transactionClient.codReconciliationRun.updateMany.mockResolvedValueOnce({
      count: 1,
    });
    transactionClient.codReconciliationRun.findUnique.mockResolvedValueOnce(
      completed,
    );

    await expect(
      repository.completeRun(runId, {
        processedCount: 4,
        matchedCount: 2,
        discrepancyCount: 1,
        uncollectedCount: 1,
      }),
    ).resolves.toEqual(completed);
    expect(transactionClient.codReconciliationRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: runId, status: 'running' },
        data: expect.objectContaining({
          status: 'completed',
          processedCount: 4,
          snapshotsWritten: true,
          errorMessage: null,
          completedAt: expect.any(Date),
        }),
      }),
    );
    expect(
      transactionClient.codReconciliationRunItem.createMany,
    ).not.toHaveBeenCalled();
  });

  it('persists every matched and discrepant snapshot with Decimal amounts', async () => {
    const completed = createRun({
      status: 'completed',
      snapshotsWritten: true,
      processedCount: 2,
      matchedCount: 1,
      discrepancyCount: 1,
    });
    transactionClient.codReconciliationRun.updateMany.mockResolvedValueOnce({
      count: 1,
    });
    transactionClient.codReconciliationRun.findUnique.mockResolvedValueOnce(
      completed,
    );
    transactionClient.codReconciliationRunItem.createMany.mockResolvedValueOnce({
      count: 2,
    });

    const records = [
      snapshotRecord(false, null),
      snapshotRecord(true, 'amount-mismatch'),
    ];

    await repository.completeRun(
      runId,
      {
        processedCount: 2,
        matchedCount: 1,
        discrepancyCount: 1,
        uncollectedCount: 0,
      },
      records,
    );

    expect(
      transactionClient.codReconciliationRunItem.createMany,
    ).toHaveBeenCalledOnce();
    const data = transactionClient.codReconciliationRunItem.createMany.mock
      .calls[0]![0].data as Prisma.CodReconciliationRunItemCreateManyInput[];
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({
      runId,
      orderId: records[0]!.orderId,
      orderStatus: 'DELIVERED',
      paymentMethod: 'COD',
      currency: 'USD',
      discrepancy: false,
      discrepancyType: null,
    });
    expect(data[1]).toMatchObject({
      orderId: records[1]!.orderId,
      discrepancy: true,
      discrepancyType: 'amount-mismatch',
    });
    expect(data[0]!.expectedAmount).toBeInstanceOf(Prisma.Decimal);
    expect(data[0]!.collectedAmount).toBeInstanceOf(Prisma.Decimal);
  });

  it('rolls back completion when a snapshot batch fails', async () => {
    transactionClient.codReconciliationRun.updateMany.mockResolvedValueOnce({
      count: 1,
    });
    transactionClient.codReconciliationRun.findUnique.mockResolvedValueOnce(
      createRun({ status: 'completed', snapshotsWritten: true }),
    );
    transactionClient.codReconciliationRunItem.createMany.mockRejectedValueOnce(
      new Error('snapshot insert failed'),
    );

    await expect(
      repository.completeRun(
        runId,
        {
          processedCount: 1,
          matchedCount: 1,
          discrepancyCount: 0,
          uncollectedCount: 0,
        },
        [snapshotRecord(false, null)],
      ),
    ).rejects.toThrow('snapshot insert failed');
  });

  it('marks a running run failed and retains the error message', async () => {
    const failed = createRun({
      status: 'failed',
      errorMessage: 'database unavailable',
      completedAt: windowEnd,
    });
    prisma.codReconciliationRun.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.codReconciliationRun.findUnique.mockResolvedValueOnce(failed);

    await expect(
      repository.markRunFailed(runId, 'database unavailable'),
    ).resolves.toEqual(failed);
    expect(prisma.codReconciliationRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: runId, status: 'running' },
        data: expect.objectContaining({
          status: 'failed',
          errorMessage: 'database unavailable',
        }),
      }),
    );
  });

  it('does not allow completed runs to be overwritten or failed', async () => {
    const completed = createRun({ status: 'completed' });
    transactionClient.codReconciliationRun.updateMany.mockResolvedValueOnce({
      count: 0,
    });
    transactionClient.codReconciliationRun.findUnique.mockResolvedValueOnce(
      completed,
    );
    prisma.codReconciliationRun.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.codReconciliationRun.findUnique.mockResolvedValueOnce(completed);

    await expect(
      repository.completeRun(runId, {
        processedCount: 1,
        matchedCount: 1,
        discrepancyCount: 0,
        uncollectedCount: 0,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      transactionClient.codReconciliationRunItem.createMany,
    ).not.toHaveBeenCalled();
    await expect(
      repository.markRunFailed(runId, 'late failure'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('reports missing runs and rejects invalid windows, pagination, and counters', async () => {
    transactionClient.codReconciliationRun.updateMany.mockResolvedValueOnce({
      count: 0,
    });
    transactionClient.codReconciliationRun.findUnique.mockResolvedValueOnce(
      null,
    );

    await expect(
      repository.completeRun(runId, {
        processedCount: 1,
        matchedCount: 1,
        discrepancyCount: 0,
        uncollectedCount: 0,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      repository.createRun('manual', windowEnd, windowStart),
    ).rejects.toThrow(RangeError);
    await expect(
      repository.findRunHistory({ page: 0, limit: 10 }),
    ).rejects.toThrow(RangeError);
    await expect(
      repository.completeRun(runId, {
        processedCount: -1,
        matchedCount: 0,
        discrepancyCount: 0,
        uncollectedCount: 0,
      }),
    ).rejects.toThrow(RangeError);
  });

  describe('claimRecoveryWindow', () => {
    const lockRow = { pg_advisory_xact_lock: null };

    it('serializes the exact-window check and claim with a PostgreSQL advisory lock', async () => {
      const created = createRun({ triggerType: 'cron' });
      transactionClient.$queryRaw
        .mockResolvedValueOnce([lockRow])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([created]);

      await expect(
        repository.claimRecoveryWindow(windowStart, windowEnd),
      ).resolves.toEqual({ outcome: 'claimed', run: created });

      const [lockQuery, lockKey] = transactionClient.$queryRaw.mock.calls[0]!;
      expect(lockQuery.join(' ')).toContain('pg_advisory_xact_lock');
      expect(lockQuery.join(' ')).toContain('hashtextextended');
      expect(lockKey).toBe(
        `cod-reconciliation:${windowStart.toISOString()}:${windowEnd.toISOString()}`,
      );

      const [
        staleQuery,
        staleMessage,
        staleStart,
        staleEnd,
        staleThreshold,
      ] = transactionClient.$executeRaw.mock.calls[0]!;
      expect(staleQuery.join(' ')).toContain('"status" = \'running\'');
      expect(staleQuery.join(' ')).toContain('NOW()');
      expect(staleMessage).toBe(RECONCILIATION_STALE_RUN_ERROR);
      expect(staleStart).toEqual(windowStart);
      expect(staleEnd).toEqual(windowEnd);
      expect(staleThreshold).toBe(RECONCILIATION_STALE_RUN_THRESHOLD_MS);

      const [selectQuery, selectStart, selectEnd] =
        transactionClient.$queryRaw.mock.calls[1]!;
      expect(selectQuery.join(' ')).toContain('"window_start" =');
      expect(selectQuery.join(' ')).toContain('"window_end" =');
      expect(selectStart).toEqual(windowStart);
      expect(selectEnd).toEqual(windowEnd);

      const [insertQuery, , insertStart, insertEnd] =
        transactionClient.$queryRaw.mock.calls[2]!;
      expect(insertQuery.join(' ')).toContain('ON CONFLICT');
      expect(insertQuery.join(' ')).toContain("'cron'");
      expect(insertStart).toEqual(windowStart);
      expect(insertEnd).toEqual(windowEnd);
    });

    it('returns busy for a fresh running run', async () => {
      const running = createRun({ triggerType: 'manual' });
      transactionClient.$queryRaw
        .mockResolvedValueOnce([lockRow])
        .mockResolvedValueOnce([running]);

      await expect(
        repository.claimRecoveryWindow(windowStart, windowEnd),
      ).resolves.toEqual({ outcome: 'busy', run: running });
      expect(transactionClient.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it('marks stale runs failed through database time and claims a new attempt', async () => {
      const stale = createRun({
        triggerType: 'cron',
        status: 'failed',
        errorMessage: RECONCILIATION_STALE_RUN_ERROR,
        completedAt: new Date(),
      });
      const created = createRun({ triggerType: 'cron' });
      transactionClient.$queryRaw
        .mockResolvedValueOnce([lockRow])
        .mockResolvedValueOnce([stale])
        .mockResolvedValueOnce([created]);

      await expect(
        repository.claimRecoveryWindow(windowStart, windowEnd),
      ).resolves.toEqual({ outcome: 'claimed', run: created });

      expect(transactionClient.$executeRaw).toHaveBeenCalledOnce();
      const [staleQuery] = transactionClient.$executeRaw.mock.calls[0]!;
      expect(staleQuery.join(' ')).toContain('"started_at" < NOW()');
      expect(transactionClient.$queryRaw).toHaveBeenCalledTimes(3);
    });

    it('treats a completed run after windowEnd as coverage regardless of trigger', async () => {
      const completed = createRun({
        triggerType: 'manual',
        status: 'completed',
        completedAt: new Date(windowEnd.getTime() + 1),
      });
      transactionClient.$queryRaw
        .mockResolvedValueOnce([lockRow])
        .mockResolvedValueOnce([completed]);

      await expect(
        repository.claimRecoveryWindow(windowStart, windowEnd),
      ).resolves.toEqual({ outcome: 'covered', run: completed });
      expect(transactionClient.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it('does not treat a run completed before windowEnd as coverage', async () => {
      const premature = createRun({
        triggerType: 'manual',
        status: 'completed',
        completedAt: new Date(windowEnd.getTime() - 1),
      });
      const created = createRun({ triggerType: 'cron' });
      transactionClient.$queryRaw
        .mockResolvedValueOnce([lockRow])
        .mockResolvedValueOnce([premature])
        .mockResolvedValueOnce([created]);

      await expect(
        repository.claimRecoveryWindow(windowStart, windowEnd),
      ).resolves.toEqual({ outcome: 'claimed', run: created });
    });

    it('retries failed runs by creating a new cron attempt', async () => {
      const failed = createRun({
        triggerType: 'cron',
        status: 'failed',
        completedAt: new Date(),
      });
      const created = createRun({ triggerType: 'cron' });
      transactionClient.$queryRaw
        .mockResolvedValueOnce([lockRow])
        .mockResolvedValueOnce([failed])
        .mockResolvedValueOnce([created]);

      await expect(
        repository.claimRecoveryWindow(windowStart, windowEnd),
      ).resolves.toEqual({ outcome: 'claimed', run: created });
      expect(created.triggerType).toBe('cron');
    });
  });

  describe('claimManualWindow', () => {
    const lockRow = { pg_advisory_xact_lock: null };

    it('allows a legitimate manual recheck after a completed cron run', async () => {
      const completedCron = createRun({
        triggerType: 'cron',
        status: 'completed',
        completedAt: new Date(windowEnd.getTime() + 1),
      });
      const created = createRun({ triggerType: 'manual' });
      transactionClient.$queryRaw
        .mockResolvedValueOnce([lockRow])
        .mockResolvedValueOnce([completedCron])
        .mockResolvedValueOnce([created]);

      await expect(
        repository.claimManualWindow(windowStart, windowEnd),
      ).resolves.toEqual({ outcome: 'claimed', run: created });
    });

    it('blocks a manual trigger while any exact-window run is active', async () => {
      const runningCron = createRun({ triggerType: 'cron' });
      transactionClient.$queryRaw
        .mockResolvedValueOnce([lockRow])
        .mockResolvedValueOnce([runningCron]);

      await expect(
        repository.claimManualWindow(windowStart, windowEnd),
      ).resolves.toEqual({ outcome: 'busy', run: runningCron });
    });

    it('preserves duplicate behavior when the partial unique index rejects the insert', async () => {
      transactionClient.$queryRaw
        .mockResolvedValueOnce([lockRow])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await expect(
        repository.claimManualWindow(windowStart, windowEnd),
      ).resolves.toEqual({ outcome: 'duplicate', run: null });
    });
  });
});
