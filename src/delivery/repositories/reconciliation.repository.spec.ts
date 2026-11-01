import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { Mock } from 'vitest';
import type { CodReconciliationRun } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DeliveryRepository } from './delivery.repository.js';
import { ReconciliationRepository } from './reconciliation.repository.js';

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
    errorMessage: null,
    startedAt: windowStart,
    completedAt: null,
    createdAt: windowStart,
    ...overrides,
  });

  beforeEach(async () => {
    const transactionClient = {
      codReconciliationRun: {
        findMany: vi.fn(),
        count: vi.fn(),
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
    prisma.codReconciliationRun.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.codReconciliationRun.findUnique.mockResolvedValueOnce(completed);

    await expect(
      repository.completeRun(runId, {
        processedCount: 4,
        matchedCount: 2,
        discrepancyCount: 1,
        uncollectedCount: 1,
      }),
    ).resolves.toEqual(completed);
    expect(prisma.codReconciliationRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: runId, status: 'running' },
        data: expect.objectContaining({
          status: 'completed',
          processedCount: 4,
          errorMessage: null,
          completedAt: expect.any(Date),
        }),
      }),
    );
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
    prisma.codReconciliationRun.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });
    prisma.codReconciliationRun.findUnique
      .mockResolvedValueOnce(completed)
      .mockResolvedValueOnce(completed);

    await expect(
      repository.completeRun(runId, {
        processedCount: 1,
        matchedCount: 1,
        discrepancyCount: 0,
        uncollectedCount: 0,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      repository.markRunFailed(runId, 'late failure'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('reports missing runs and rejects invalid windows, pagination, and counters', async () => {
    prisma.codReconciliationRun.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.codReconciliationRun.findUnique.mockResolvedValueOnce(null);

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
});
