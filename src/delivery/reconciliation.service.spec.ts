import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { CodReconciliationRecordItem } from './repositories/delivery.repository.js';
import {
  ReconciliationRepository,
  type ReconciliationRunCounters,
} from './repositories/reconciliation.repository.js';
import {
  ReconciliationService,
  type ReconciliationExecutionResult,
} from './reconciliation.service.js';

describe('ReconciliationService', () => {
  let service: ReconciliationService;
  let repository: {
    claimRecoveryWindow: ReturnType<typeof vi.fn>;
    claimManualWindow: ReturnType<typeof vi.fn>;
    findReconciliationData: ReturnType<typeof vi.fn>;
    findRunSnapshot: ReturnType<typeof vi.fn>;
    completeRun: ReturnType<typeof vi.fn>;
    markRunFailed: ReturnType<typeof vi.fn>;
  };

  const run = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    triggerType: 'manual' as const,
    status: 'running' as const,
    windowStart: new Date('2026-10-01T00:00:00.000Z'),
    windowEnd: new Date('2026-10-02T00:00:00.000Z'),
    processedCount: 0,
    matchedCount: 0,
    discrepancyCount: 0,
    uncollectedCount: 0,
    snapshotsWritten: false,
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

  const execution = (
    start = windowStart,
    end = windowEnd,
  ): ReconciliationExecutionResult => ({
    run: {
      ...run,
      status: 'completed',
      windowStart: start,
      windowEnd: end,
      completedAt: new Date(end.getTime() + 60_000),
    },
    counters: {
      processedCount: 0,
      matchedCount: 0,
      discrepancyCount: 0,
      uncollectedCount: 0,
    },
    discrepancyBreakdown: {
      missingCollections: 0,
      amountMismatches: 0,
      currencyMismatches: 0,
    },
  });

  beforeEach(async () => {
    repository = {
      claimRecoveryWindow: vi
        .fn()
        .mockResolvedValue({ outcome: 'claimed', run }),
      claimManualWindow: vi.fn().mockResolvedValue({ outcome: 'claimed', run }),
      findReconciliationData: vi.fn().mockResolvedValue([]),
      findRunSnapshot: vi.fn().mockResolvedValue({
        run,
        items: [],
        total: 0,
        summaryByCurrency: [],
      }),
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

  it('claims, reconciles, and completes a cron run with accurate counters', async () => {
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

    expect(repository.claimRecoveryWindow).toHaveBeenCalledWith(
      windowStart,
      windowEnd,
    );
    expect(repository.claimManualWindow).not.toHaveBeenCalled();
    expect(repository.findReconciliationData).toHaveBeenCalledWith(
      windowStart,
      windowEnd,
    );
    expect(repository.completeRun).toHaveBeenCalledWith(
      run.id,
      counters,
      expect.arrayContaining([
        expect.objectContaining({ orderId: record(false, null).orderId }),
      ]),
    );
    expect(repository.markRunFailed).not.toHaveBeenCalled();
  });

  it('uses the manual claim path for manual runs', async () => {
    await expect(
      service.reconcileWindow(windowStart, windowEnd, 'manual'),
    ).resolves.toMatchObject({ run: { ...run, status: 'completed' } });

    expect(repository.claimManualWindow).toHaveBeenCalledWith(
      windowStart,
      windowEnd,
    );
    expect(repository.claimRecoveryWindow).not.toHaveBeenCalled();
  });

  it('returns a run snapshot page and maps a missing run to 404', async () => {
    await expect(service.getRunDetail(run.id, 2, 5)).resolves.toMatchObject({
      run,
      items: [],
      total: 0,
      summaryByCurrency: [],
    });
    expect(repository.findRunSnapshot).toHaveBeenCalledWith(run.id, {
      page: 2,
      limit: 5,
    });

    repository.findRunSnapshot.mockResolvedValueOnce(null);
    await expect(
      service.getRunDetail(run.id, 1, 20),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not execute a run that was not claimed', async () => {
    repository.claimManualWindow.mockResolvedValueOnce({
      outcome: 'busy',
      run,
    });

    await expect(
      service.reconcileWindow(windowStart, windowEnd, 'manual'),
    ).resolves.toBeNull();

    expect(repository.findReconciliationData).not.toHaveBeenCalled();
    expect(repository.completeRun).not.toHaveBeenCalled();
    expect(repository.markRunFailed).not.toHaveBeenCalled();
  });

  it('maps a non-claim to the existing manual conflict behavior', async () => {
    repository.claimManualWindow.mockResolvedValueOnce({
      outcome: 'duplicate',
      run: null,
    });

    await expect(
      service.triggerManualReconciliation(windowStart, windowEnd),
    ).rejects.toBeInstanceOf(ConflictException);
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
    expect(repository.completeRun).toHaveBeenCalledWith(
      run.id,
      zeroCounters,
      [],
    );
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

  describe('recoverMissedUtcDays', () => {
    const now = new Date('2026-11-05T09:30:00.000Z');
    const startOf = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

    it('uses a bounded 30-day lookback, oldest first, excluding the current day', async () => {
      const reconcileSpy = vi
        .spyOn(service, 'reconcileWindow')
        .mockImplementation(async (start, end) => execution(start, end));

      await expect(service.recoverMissedUtcDays(now)).resolves.toEqual({
        windowsScanned: 30,
        recovered: 30,
        skipped: 0,
        failed: 0,
      });

      const calls = reconcileSpy.mock.calls;
      expect(calls).toHaveLength(30);
      expect(calls[0]?.[0]).toEqual(startOf('2026-10-06'));
      expect(calls[0]?.[1]).toEqual(startOf('2026-10-07'));
      expect(calls.at(-1)?.[0]).toEqual(startOf('2026-11-04'));
      expect(calls.at(-1)?.[1]).toEqual(startOf('2026-11-05'));
      expect(
        calls.every(
          ([, end], index) =>
            end.getTime() <= now.getTime() &&
            end.getTime() ===
              (calls[index + 1]?.[0]?.getTime() ??
                new Date('2026-11-05T00:00:00.000Z').getTime()),
        ),
      ).toBe(true);
      expect(
        calls.some(
          ([start]) => start.toISOString() === '2026-11-05T00:00:00.000Z',
        ),
      ).toBe(false);
      for (const call of calls) {
        expect(call[2]).toBe('cron');
      }
    });

    it('recovers exactly three missed UTC days', async () => {
      const missed = new Set([
        '2026-11-02T00:00:00.000Z',
        '2026-11-03T00:00:00.000Z',
        '2026-11-04T00:00:00.000Z',
      ]);
      const reconcileSpy = vi
        .spyOn(service, 'reconcileWindow')
        .mockImplementation(async (start, end) =>
          missed.has(start.toISOString()) ? execution(start, end) : null,
        );

      await expect(service.recoverMissedUtcDays(now)).resolves.toEqual({
        windowsScanned: 30,
        recovered: 3,
        skipped: 27,
        failed: 0,
      });

      expect(
        reconcileSpy.mock.calls
          .filter(([start]) => missed.has(start.toISOString()))
          .map(([start]) => start.toISOString()),
      ).toEqual([
        '2026-11-02T00:00:00.000Z',
        '2026-11-03T00:00:00.000Z',
        '2026-11-04T00:00:00.000Z',
      ]);
    });

    it('isolates a failure and continues with later windows', async () => {
      const failedStart = '2026-11-03T00:00:00.000Z';
      const reconcileSpy = vi
        .spyOn(service, 'reconcileWindow')
        .mockImplementation(async (start) => {
          if (start.toISOString() === failedStart) {
            throw new Error('window failed');
          }
          return null;
        });

      await expect(service.recoverMissedUtcDays(now)).resolves.toEqual({
        windowsScanned: 30,
        recovered: 0,
        skipped: 29,
        failed: 1,
      });

      expect(reconcileSpy.mock.calls).toHaveLength(30);
      expect(
        reconcileSpy.mock.calls.some(
          ([start]) => start.toISOString() === '2026-11-04T00:00:00.000Z',
        ),
      ).toBe(true);
    });
  });
});
