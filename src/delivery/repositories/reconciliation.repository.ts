import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client.js';
import type { CodReconciliationRun } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  DeliveryRepository,
  type CodReconciliationRecordItem,
} from './delivery.repository.js';

export type ReconciliationTriggerType = 'cron' | 'manual';

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

const RECONCILIATION_PAGE_SIZE = 500;

@Injectable()
export class ReconciliationRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveryRepository: DeliveryRepository,
  ) {}

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

  async completeRun(
    id: string,
    counters: ReconciliationRunCounters,
  ): Promise<CodReconciliationRun> {
    this.validateCounters(counters);

    const result = await this.prisma.codReconciliationRun.updateMany({
      where: { id, status: 'running' },
      data: {
        ...counters,
        status: 'completed',
        completedAt: new Date(),
        errorMessage: null,
      },
    });

    return this.getTransitionedRun(id, result.count);
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
