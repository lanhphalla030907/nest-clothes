import { Test, TestingModule } from '@nestjs/testing';
import type { CodReconciliationRecordItem } from './repositories/delivery.repository.js';
import {
  ReconciliationRepository,
  type ReconciliationRunCounters,
} from './repositories/reconciliation.repository.js';
import { ReconciliationService } from './reconciliation.service.js';

describe('ReconciliationService', () => {
  let service: ReconciliationService;
  let repository: {
    createRun: ReturnType<typeof vi.fn>;
    findReconciliationData: ReturnType<typeof vi.fn>;
    completeRun: ReturnType<typeof vi.fn>;
    markRunFailed: ReturnType<typeof vi.fn>;
  };

  const run = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    triggerType: 'manual',
    status: 'running',
    windowStart: new Date('2026-10-01T00:00:00.000Z'),
    windowEnd: new Date('2026-10-02T00:00:00.000Z'),
    processedCount: 0,
    matchedCount: 0,
    discrepancyCount: 0,
    uncollectedCount: 0,
    errorMessage: null,
    startedAt: new Date('2026-10-01T00:00:00.000Z'),
    completedAt: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
  };
  const windowStart = new Date('2026-10-01T00:00:00.000Z');
  const windowEnd = new Date('2026-10-02T00:00:00.000Z');

  const record = (
    discrepancy: boolean,
    discrepancyType: CodReconciliationRecordItem['discrepancyType'],
  ): CodReconciliationRecordItem =>
    ({
      orderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      orderNumber: 'ORDER-1',
      orderStatus: 'DELIVERED',
      paymentMethod: 'COD',
      totalAmount: { toString: () => '10.00' },
      expectedAmount: { toString: () => '10.00' },
      currency: 'USD',
      collectedAmount: null,
      collectionId: null,
      collectedAt: null,
      collectedById: null,
      collectedBy: null,
      deliveryStaffId: null,
      deliveryStaff: null,
      deliveredAt: windowStart,
      discrepancy,
      discrepancyType,
    }) as CodReconciliationRecordItem;

  const counters: ReconciliationRunCounters = {
    processedCount: 5,
    matchedCount: 2,
    discrepancyCount: 3,
    uncollectedCount: 1,
  };

  beforeEach(async () => {
    repository = {
      createRun: vi.fn().mockResolvedValue(run),
      findReconciliationData: vi.fn().mockResolvedValue([]),
      completeRun: vi.fn().mockResolvedValue({ ...run, status: 'completed' }),
      markRunFailed: vi.fn().mockResolvedValue({ ...run, status: 'failed' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReconciliationService,
        { provide: ReconciliationRepository, useValue: repository },
      ],
    }).compile();

    service = module.get(ReconciliationService);
  });

  it('creates, reconciles, and completes a run with accurate counters', async () => {
    repository.findReconciliationData.mockResolvedValueOnce([
      record(false, null),
      record(false, null),
      record(true, 'missing-collection'),
      record(true, 'amount-mismatch'),
      record(true, 'currency-mismatch'),
    ]);
    repository.completeRun.mockResolvedValueOnce({
      ...run,
      status: 'completed',
      ...counters,
    });

    await expect(
      service.reconcileWindow(windowStart, windowEnd, 'cron'),
    ).resolves.toEqual({
      run: { ...run, status: 'completed', ...counters },
      counters,
      discrepancyBreakdown: {
        missingCollections: 1,
        amountMismatches: 1,
        currencyMismatches: 1,
      },
    });

    expect(repository.createRun).toHaveBeenCalledWith(
      'cron',
      windowStart,
      windowEnd,
    );
    expect(repository.findReconciliationData).toHaveBeenCalledWith(
      windowStart,
      windowEnd,
    );
    expect(repository.completeRun).toHaveBeenCalledWith(run.id, counters);
    expect(repository.markRunFailed).not.toHaveBeenCalled();
  });

  it('does not execute a duplicate run', async () => {
    repository.createRun.mockResolvedValueOnce(null);

    await expect(
      service.reconcileWindow(windowStart, windowEnd, 'manual'),
    ).resolves.toBeNull();

    expect(repository.findReconciliationData).not.toHaveBeenCalled();
    expect(repository.completeRun).not.toHaveBeenCalled();
    expect(repository.markRunFailed).not.toHaveBeenCalled();
  });

  it('completes an empty window with zero counters', async () => {
    const zeroCounters: ReconciliationRunCounters = {
      processedCount: 0,
      matchedCount: 0,
      discrepancyCount: 0,
      uncollectedCount: 0,
    };

    await expect(
      service.reconcileWindow(windowStart, windowEnd, 'manual'),
    ).resolves.toMatchObject({
      counters: zeroCounters,
      discrepancyBreakdown: {
        missingCollections: 0,
        amountMismatches: 0,
        currencyMismatches: 0,
      },
    });
    expect(repository.completeRun).toHaveBeenCalledWith(run.id, zeroCounters);
  });

  it('records reconciliation failures and propagates the original error', async () => {
    const failure = new Error('query failed');
    repository.findReconciliationData.mockRejectedValueOnce(failure);

    await expect(
      service.reconcileWindow(windowStart, windowEnd, 'manual'),
    ).rejects.toBe(failure);
    expect(repository.markRunFailed).toHaveBeenCalledWith(run.id, 'query failed');
    expect(repository.completeRun).not.toHaveBeenCalled();
  });

  it('records a failure when persisting completion fails', async () => {
    repository.completeRun.mockRejectedValueOnce(new Error('completion failed'));

    await expect(
      service.reconcileWindow(windowStart, windowEnd, 'manual'),
    ).rejects.toThrow('completion failed');
    expect(repository.markRunFailed).toHaveBeenCalledWith(
      run.id,
      'completion failed',
    );
  });

  it('preserves the original failure when the run cannot be marked failed', async () => {
    repository.findReconciliationData.mockRejectedValueOnce(
      new Error('query failed'),
    );
    repository.markRunFailed.mockRejectedValueOnce(
      new Error('run is already completed'),
    );

    await expect(
      service.reconcileWindow(windowStart, windowEnd, 'manual'),
    ).rejects.toBeInstanceOf(AggregateError);
  });
});
