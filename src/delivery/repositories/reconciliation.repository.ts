import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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

export type ReconciliationTriggerType = 'cron' | 'manual';

/**
 * Reconciliation data is read inside a transaction with a 60-second timeout.
 * Fifteen minutes leaves ample headroom for the query, completion write, and
 * network/process pauses before a running row is treated as abandoned.
 */
export const RECONCILIATION_STALE_RUN_THRESHOLD_MS = 15 * 60 * 1000;
export const RECONCILIATION_STALE_RUN_ERROR =
  'Reconciliation run exceeded the 15-minute stale threshold';

export type ReconciliationRunClaimOutcome =
  | 'claimed'
  | 'covered'
  | 'busy'
  | 'duplicate';

export interface ReconciliationRunClaim {
  outcome: ReconciliationRunClaimOutcome;
  run: CodReconciliationRun | null;
}

export interface ReconciliationRunCounters {
  processedCount: number;
  matchedCount: number;
  discrepancyCount: number;
  uncollectedCount: number;
}

export interface ReconciliationRunHistoryPage {
  page: number;
  limit: number;
  status?: 'running' | 'completed' | 'failed';
  triggerType?: ReconciliationTriggerType;
  startDate?: Date;
  endDate?: Date;
}

export interface ReconciliationRunHistory {
  items: CodReconciliationRun[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ReconciliationRunSnapshotPage {
  page: number;
  limit: number;
}

/** Expected and collected totals for one currency, kept strictly separate. */
export interface ReconciliationRunSnapshotSummary {
  currency: string;
  expectedCount: number;
  expectedAmount: Prisma.Decimal;
  matchedCount: number;
  discrepancyCount: number;
  collectedCount: number;
  collectedAmount: Prisma.Decimal;
}

export interface ReconciliationRunSnapshotResult {
  run: CodReconciliationRun;
  items: CodReconciliationRunItem[];
  total: number;
  summaryByCurrency: ReconciliationRunSnapshotSummary[];
}

const RECONCILIATION_PAGE_SIZE = 500;
const SNAPSHOT_BATCH_SIZE = 500;

@Injectable()
export class ReconciliationRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveryRepository: DeliveryRepository,
  ) {}

  private toRun(row: Record<string, unknown>): CodReconciliationRun {
    return {
      id: row.id as string,
      triggerType: row.triggerType as ReconciliationTriggerType,
      status: row.status as 'running' | 'completed' | 'failed',
      windowStart: row.windowStart as Date,
      windowEnd: row.windowEnd as Date,
      processedCount: row.processedCount as number,
      matchedCount: row.matchedCount as number,
      discrepancyCount: row.discrepancyCount as number,
      uncollectedCount: row.uncollectedCount as number,
      snapshotsWritten: Boolean(row.snapshotsWritten),
      errorMessage: row.errorMessage as string | null,
      startedAt: row.startedAt as Date,
      completedAt: row.completedAt as Date | null,
      createdAt: row.createdAt as Date,
    };
  }

  private isCompletedAfterWindowEnd(
    run: CodReconciliationRun,
    windowEnd: Date,
  ): boolean {
    if (run.status !== 'completed') {
      return false;
    }
    if (!run.completedAt) {
      return false;
    }
    return run.completedAt.getTime() >= windowEnd.getTime();
  }

  async claimRecoveryWindow(
    windowStart: Date,
    windowEnd: Date,
    staleThresholdMs = RECONCILIATION_STALE_RUN_THRESHOLD_MS,
  ): Promise<ReconciliationRunClaim> {
    this.validateWindow(windowStart, windowEnd);
    const lockKey = `cod-reconciliation:${windowStart.toISOString()}:${windowEnd.toISOString()}`;

    return this.prisma.$transaction(async (tx) => {
      // Per-window advisory lock: serializes the check/claim decision across
      // concurrent manual triggers and recovery sweeps, including cross-instance
      // processes that use the same PostgreSQL database.
      await tx.$queryRaw`
        SELECT 1 AS "locked"
        FROM (
          SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}::text, 0))
        ) AS "advisory_lock"
      `;

      // PostgreSQL time is authoritative for staleness. The existing
      // reconciliation query has a 60-second transaction timeout, so 15 minutes
      // is a conservative stale threshold.
      await tx.$executeRaw`
        UPDATE "cod_reconciliation_runs"
        SET
          "status" = 'failed',
          "error_message" = ${RECONCILIATION_STALE_RUN_ERROR},
          "completed_at" = NOW()
        WHERE "window_start" = ${windowStart}
          AND "window_end" = ${windowEnd}
          AND "status" = 'running'
          AND "started_at" < NOW() - (${staleThresholdMs} * INTERVAL '1 millisecond')
      `;

      const rows = await tx.$queryRaw<Record<string, unknown>[]>`
        SELECT
          "id",
          "trigger_type" AS "triggerType",
          "status",
          "window_start" AS "windowStart",
          "window_end" AS "windowEnd",
          "processed_count" AS "processedCount",
          "matched_count" AS "matchedCount",
          "discrepancy_count" AS "discrepancyCount",
          "uncollected_count" AS "uncollectedCount",
          "snapshots_written" AS "snapshotsWritten",
          "error_message" AS "errorMessage",
          "started_at" AS "startedAt",
          "completed_at" AS "completedAt",
          "created_at" AS "createdAt"
        FROM "cod_reconciliation_runs"
        WHERE "window_start" = ${windowStart}
          AND "window_end" = ${windowEnd}
        ORDER BY "created_at" DESC, "id" DESC
        FOR UPDATE
      `;

      const runs = rows.map((row) => this.toRun(row));

      // Any qualifying completed run (any trigger) counts as coverage, but
      // only if it completed after the window closed. Premature manual runs do
      // not count as daily coverage.
      for (const run of runs) {
        if (this.isCompletedAfterWindowEnd(run, windowEnd)) {
          return { outcome: 'covered', run };
        }
      }

      // Any remaining running run is fresh (stale rows were failed above).
      for (const run of runs) {
        if (run.status === 'running') {
          return { outcome: 'busy', run };
        }
      }

      // Failed runs are retryable; we do not mutate them. Create a new attempt.
      const id = randomUUID();
      const inserted = await tx.$queryRaw<Record<string, unknown>[]>`
        INSERT INTO "cod_reconciliation_runs" (
          "id", "trigger_type", "status", "window_start", "window_end"
        )
        VALUES (
          ${id}::uuid, 'cron', 'running', ${windowStart}, ${windowEnd}
        )
        ON CONFLICT ("window_start", "window_end", "trigger_type")
          WHERE "status" <> 'failed'
        DO NOTHING
        RETURNING
          "id",
          "trigger_type" AS "triggerType",
          "status",
          "window_start" AS "windowStart",
          "window_end" AS "windowEnd",
          "processed_count" AS "processedCount",
          "matched_count" AS "matchedCount",
          "discrepancy_count" AS "discrepancyCount",
          "uncollected_count" AS "uncollectedCount",
          "snapshots_written" AS "snapshotsWritten",
          "error_message" AS "errorMessage",
          "started_at" AS "startedAt",
          "completed_at" AS "completedAt",
          "created_at" AS "createdAt"
      `;

      if (inserted.length === 0) {
        // Defensive: the advisory lock should have prevented this. The partial
        // unique index remains the final concurrency guard.
        return { outcome: 'duplicate', run: null };
      }

      return { outcome: 'claimed', run: this.toRun(inserted[0]) };
    });
  }

  async claimManualWindow(
    windowStart: Date,
    windowEnd: Date,
  ): Promise<ReconciliationRunClaim> {
    this.validateWindow(windowStart, windowEnd);
    const lockKey = `cod-reconciliation:${windowStart.toISOString()}:${windowEnd.toISOString()}`;

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT 1 AS "locked"
        FROM (
          SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}::text, 0))
        ) AS "advisory_lock"
      `;

      const rows = await tx.$queryRaw<Record<string, unknown>[]>`
        SELECT
          "id",
          "trigger_type" AS "triggerType",
          "status",
          "window_start" AS "windowStart",
          "window_end" AS "windowEnd",
          "processed_count" AS "processedCount",
          "matched_count" AS "matchedCount",
          "discrepancy_count" AS "discrepancyCount",
          "uncollected_count" AS "uncollectedCount",
          "snapshots_written" AS "snapshotsWritten",
          "error_message" AS "errorMessage",
          "started_at" AS "startedAt",
          "completed_at" AS "completedAt",
          "created_at" AS "createdAt"
        FROM "cod_reconciliation_runs"
        WHERE "window_start" = ${windowStart}
          AND "window_end" = ${windowEnd}
        ORDER BY "created_at" DESC, "id" DESC
        FOR UPDATE
      `;
      const runs = rows.map((row) => this.toRun(row));

      // A manual recheck must remain possible after a completed cron run. A
      // fully completed manual run for the same exact window is still handled
      // by the existing partial unique index below, preserving HTTP 409.
      for (const run of runs) {
        if (run.status === 'running') {
          return { outcome: 'busy', run };
        }
      }

      const id = randomUUID();
      const inserted = await tx.$queryRaw<Record<string, unknown>[]>`
        INSERT INTO "cod_reconciliation_runs" (
          "id", "trigger_type", "status", "window_start", "window_end"
        )
        VALUES (
          ${id}::uuid, 'manual', 'running', ${windowStart}, ${windowEnd}
        )
        ON CONFLICT ("window_start", "window_end", "trigger_type")
          WHERE "status" <> 'failed'
        DO NOTHING
        RETURNING
          "id",
          "trigger_type" AS "triggerType",
          "status",
          "window_start" AS "windowStart",
          "window_end" AS "windowEnd",
          "processed_count" AS "processedCount",
          "matched_count" AS "matchedCount",
          "discrepancy_count" AS "discrepancyCount",
          "uncollected_count" AS "uncollectedCount",
          "snapshots_written" AS "snapshotsWritten",
          "error_message" AS "errorMessage",
          "started_at" AS "startedAt",
          "completed_at" AS "completedAt",
          "created_at" AS "createdAt"
      `;
      if (inserted.length === 0) {
        return { outcome: 'duplicate', run: null };
      }
      return { outcome: 'claimed', run: this.toRun(inserted[0]) };
    });
  }

  async createRun(
    triggerType: ReconciliationTriggerType,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<CodReconciliationRun | null> {
    this.validateWindow(windowStart, windowEnd);

    const id = randomUUID();
    const rows = await this.prisma.$queryRaw<CodReconciliationRun[]>`
      INSERT INTO "cod_reconciliation_runs" (
        "id", "trigger_type", "status", "window_start", "window_end"
      )
      VALUES (
        ${id}::uuid, ${triggerType}, 'running', ${windowStart}, ${windowEnd}
      )
      ON CONFLICT ("window_start", "window_end", "trigger_type")
        WHERE "status" <> 'failed'
      DO NOTHING
      RETURNING
        "id",
        "trigger_type" AS "triggerType",
        "status",
        "window_start" AS "windowStart",
        "window_end" AS "windowEnd",
        "processed_count" AS "processedCount",
        "matched_count" AS "matchedCount",
        "discrepancy_count" AS "discrepancyCount",
        "uncollected_count" AS "uncollectedCount",
        "snapshots_written" AS "snapshotsWritten",
        "error_message" AS "errorMessage",
        "started_at" AS "startedAt",
        "completed_at" AS "completedAt",
        "created_at" AS "createdAt"
    `;

    return rows[0] ?? null;
  }

  findRunById(id: string): Promise<CodReconciliationRun | null> {
    return this.prisma.codReconciliationRun.findUnique({ where: { id } });
  }

  async findRunHistory(
    { page, limit, status, triggerType, startDate, endDate }: ReconciliationRunHistoryPage,
  ): Promise<ReconciliationRunHistory> {
    this.validatePagination(page, limit);

    if (
      (startDate && Number.isNaN(startDate.getTime())) ||
      (endDate && Number.isNaN(endDate.getTime())) ||
      (startDate && endDate && startDate > endDate)
    ) {
      throw new RangeError('Run history date range is invalid');
    }

    const where: Prisma.CodReconciliationRunWhereInput = {
      ...(status ? { status } : {}),
      ...(triggerType ? { triggerType } : {}),
      ...(startDate || endDate
        ? {
            windowStart: {
              ...(startDate ? { gte: startDate } : {}),
              ...(endDate ? { lte: endDate } : {}),
            },
          }
        : {}),
    };

    return this.prisma.$transaction(
      async (tx) => {
        const items = await tx.codReconciliationRun.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * limit,
          take: limit,
        });
        const total = await tx.codReconciliationRun.count({ where });

        return {
          items,
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async findRunSnapshot(
    id: string,
    { page, limit }: ReconciliationRunSnapshotPage,
  ): Promise<ReconciliationRunSnapshotResult | null> {
    this.validatePagination(page, limit);

    return this.prisma.$transaction(
      async (tx) => {
        const run = await tx.codReconciliationRun.findUnique({ where: { id } });

        if (!run) {
          return null;
        }

        // `snapshotsWritten` is the only authority for snapshot availability. A
        // legacy run completed before snapshot persistence can never acquire one,
        // even if a later live query would happen to find matching orders.
        if (!run.snapshotsWritten) {
          return {
            run,
            items: [],
            total: 0,
            summaryByCurrency: [],
          };
        }

        const where = { runId: id };

        const [
          items,
          total,
          expectedRows,
          collectedRows,
          matchedRows,
          discrepancyRows,
        ] = await Promise.all([
          tx.codReconciliationRunItem.findMany({
            where,
            orderBy: [
              { deliveredAt: { sort: 'asc', nulls: 'last' } },
              { orderNumber: { sort: 'asc', nulls: 'last' } },
              { orderId: 'asc' },
              { id: 'asc' },
            ],
            skip: (page - 1) * limit,
            take: limit,
          }),
          tx.codReconciliationRunItem.count({ where }),
          tx.codReconciliationRunItem.groupBy({
            by: ['currency'],
            where,
            orderBy: { currency: 'asc' },
            _sum: { expectedAmount: true },
            _count: true,
          }),
          tx.codReconciliationRunItem.groupBy({
            by: ['collectionCurrency'],
            where: {
              runId: id,
              collectionCurrency: { not: null },
            },
            orderBy: { collectionCurrency: 'asc' },
            _sum: { collectedAmount: true },
            _count: true,
          }),
          tx.codReconciliationRunItem.groupBy({
            by: ['currency'],
            where: { runId: id, discrepancy: false },
            _count: true,
          }),
          tx.codReconciliationRunItem.groupBy({
            by: ['currency'],
            where: { runId: id, discrepancy: true },
            _count: true,
          }),
        ]);

        const summaries = new Map<string, ReconciliationRunSnapshotSummary>();
        const summaryFor = (
          currency: string,
        ): ReconciliationRunSnapshotSummary => {
          const existing = summaries.get(currency);
          if (existing) {
            return existing;
          }
          const created: ReconciliationRunSnapshotSummary = {
            currency,
            expectedCount: 0,
            expectedAmount: new Prisma.Decimal(0),
            matchedCount: 0,
            discrepancyCount: 0,
            collectedCount: 0,
            collectedAmount: new Prisma.Decimal(0),
          };
          summaries.set(currency, created);
          return created;
        };

        for (const row of expectedRows) {
          const summary = summaryFor(row.currency);
          summary.expectedCount = row._count;
          summary.expectedAmount = row._sum.expectedAmount ?? new Prisma.Decimal(0);
        }

        for (const row of collectedRows) {
          // The query filters out null collection currencies, so this is safe.
          const summary = summaryFor(row.collectionCurrency!);
          summary.collectedCount = row._count;
          summary.collectedAmount =
            row._sum.collectedAmount ?? new Prisma.Decimal(0);
        }

        for (const row of matchedRows) {
          const summary = summaryFor(row.currency);
          summary.matchedCount = row._count;
        }

        for (const row of discrepancyRows) {
          const summary = summaryFor(row.currency);
          summary.discrepancyCount = row._count;
        }

        return {
          run,
          items,
          total,
          summaryByCurrency: [...summaries.values()].sort((left, right) =>
            left.currency.localeCompare(right.currency),
          ),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async findReconciliationData(
    windowStart: Date,
    windowEnd: Date,
  ): Promise<CodReconciliationRecordItem[]> {
    this.validateWindow(windowStart, windowEnd);

    return this.prisma.$transaction(
      async (tx) => {
        const records: CodReconciliationRecordItem[] = [];
        let page = 1;
        let total = 0;

        do {
          const result =
            await this.deliveryRepository.findCodReconciliationRecords(
              {
                startDate: windowStart,
                endDateExclusive: windowEnd,
                page,
                limit: RECONCILIATION_PAGE_SIZE,
                sortBy: 'deliveryDate',
                sortOrder: 'asc',
              },
              tx,
            );

          records.push(...result.items);
          total = result.total;
          if (result.items.length === 0 && records.length < total) {
            throw new Error(
              'Reconciliation query returned no records before reaching its total',
            );
          }
          page += 1;
        } while (records.length < total);

        return records;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 60_000,
      },
    );
  }

  /**
   * Persists a run's immutable item snapshots and completes the run atomically.
   *
   * The conditional `status = 'running'` transition, the completed counters, the
   * `snapshotsWritten` marker and every snapshot row live in one transaction. A
   * failed snapshot batch therefore rolls the completion back, leaving the run
   * running so the service can mark it failed through its separate claim.
   */
  async completeRun(
    id: string,
    counters: ReconciliationRunCounters,
    records: CodReconciliationRecordItem[] = [],
  ): Promise<CodReconciliationRun> {
    this.validateCounters(counters);

    return this.prisma.$transaction(
      async (tx) => {
        const result = await tx.codReconciliationRun.updateMany({
          where: { id, status: 'running' },
          data: {
            ...counters,
            status: 'completed',
            completedAt: new Date(),
            errorMessage: null,
            snapshotsWritten: true,
          },
        });

        const run = await tx.codReconciliationRun.findUnique({ where: { id } });

        if (!run) {
          throw new NotFoundException(
            `Reconciliation run "${id}" was not found`,
          );
        }

        if (result.count === 0) {
          throw new ConflictException(
            `Reconciliation run "${id}" is already ${run.status}`,
          );
        }

        const snapshots = records.map((record) => ({
          id: randomUUID(),
          runId: id,
          orderId: record.orderId,
          orderNumber: record.orderNumber,
          orderStatus: record.orderStatus,
          paymentMethod: record.paymentMethod,
          currency: record.currency,
          expectedAmount: record.expectedAmount,
          collectedAmount: record.collectedAmount,
          collectionCurrency: record.collectionCurrency,
          collectionId: record.collectionId,
          collectedAt: record.collectedAt,
          collectedById: record.collectedById,
          collectedByFirstName: record.collectedBy?.firstName ?? null,
          collectedByLastName: record.collectedBy?.lastName ?? null,
          collectedByEmail: record.collectedBy?.email ?? null,
          deliveryStaffId: record.deliveryStaffId,
          deliveryStaffFirstName: record.deliveryStaff?.firstName ?? null,
          deliveryStaffLastName: record.deliveryStaff?.lastName ?? null,
          deliveryStaffEmail: record.deliveryStaff?.email ?? null,
          deliveredAt: record.deliveredAt,
          assignmentId: record.assignmentId,
          discrepancy: record.discrepancy,
          discrepancyType: record.discrepancyType,
        })) satisfies Prisma.CodReconciliationRunItemCreateManyInput[];

        for (let index = 0; index < snapshots.length; index += SNAPSHOT_BATCH_SIZE) {
          await tx.codReconciliationRunItem.createMany({
            data: snapshots.slice(index, index + SNAPSHOT_BATCH_SIZE),
          });
        }

        return run;
      },
      { timeout: 60_000 },
    );
  }

  async markRunFailed(
    id: string,
    errorMessage: string,
  ): Promise<CodReconciliationRun> {
    const result = await this.prisma.codReconciliationRun.updateMany({
      where: { id, status: 'running' },
      data: {
        status: 'failed',
        errorMessage,
        completedAt: new Date(),
      },
    });

    return this.getTransitionedRun(id, result.count);
  }

  private async getTransitionedRun(
    id: string,
    updatedCount: number,
  ): Promise<CodReconciliationRun> {
    const run = await this.findRunById(id);

    if (!run) {
      throw new NotFoundException(`Reconciliation run "${id}" was not found`);
    }

    if (updatedCount === 0) {
      throw new ConflictException(
        `Reconciliation run "${id}" is already ${run.status}`,
      );
    }

    return run;
  }

  private validateWindow(windowStart: Date, windowEnd: Date): void {
    if (
      Number.isNaN(windowStart.getTime()) ||
      Number.isNaN(windowEnd.getTime()) ||
      windowStart >= windowEnd
    ) {
      throw new RangeError('Reconciliation window must have start before end');
    }
  }

  private validatePagination(page: number, limit: number): void {
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      !Number.isSafeInteger((page - 1) * limit)
    ) {
      throw new RangeError('Run history page and limit must be positive integers');
    }
  }

  private validateCounters(counters: ReconciliationRunCounters): void {
    for (const [name, value] of Object.entries(counters)) {
      if (!Number.isInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative integer`);
      }
    }
  }
}
