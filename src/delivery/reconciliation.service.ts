import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { CodReconciliationRun } from '../generated/prisma/client.js';
import {
  getRecoveryUtcDailyWindows,
  RECONCILIATION_RECOVERY_LOOKBACK_DAYS,
} from './reconciliation-window.js';
import {
  ReconciliationRepository,
  type ReconciliationRunCounters,
  type ReconciliationRunHistory,
  type ReconciliationRunHistoryPage,
  type ReconciliationRunSnapshotResult,
  type ReconciliationTriggerType,
} from './repositories/reconciliation.repository.js';
import type { CodReconciliationRecordItem } from './repositories/delivery.repository.js';

export interface ReconciliationDiscrepancyBreakdown {
  missingCollections: number;
  amountMismatches: number;
  currencyMismatches: number;
}

export interface ReconciliationExecutionResult {
  run: CodReconciliationRun;
  counters: ReconciliationRunCounters;
  discrepancyBreakdown: ReconciliationDiscrepancyBreakdown;
}

interface ReconciliationCounts {
  counters: ReconciliationRunCounters;
  discrepancyBreakdown: ReconciliationDiscrepancyBreakdown;
}

export interface ReconciliationRecoverySummary {
  windowsScanned: number;
  recovered: number;
  skipped: number;
  failed: number;
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(private readonly repository: ReconciliationRepository) {}

  getRunHistory(
    query: ReconciliationRunHistoryPage,
  ): Promise<ReconciliationRunHistory> {
    return this.repository.findRunHistory(query);
  }

  async getRun(id: string): Promise<CodReconciliationRun> {
    const run = await this.repository.findRunById(id);
    if (!run) {
      throw new NotFoundException('Reconciliation run not found');
    }
    return run;
  }

  async getRunDetail(
    id: string,
    page: number,
    limit: number,
  ): Promise<ReconciliationRunSnapshotResult> {
    const result = await this.repository.findRunSnapshot(id, { page, limit });
    if (!result) {
      throw new NotFoundException('Reconciliation run not found');
    }
    return result;
  }

  async triggerManualReconciliation(
    windowStart?: Date,
    windowEnd?: Date,
  ): Promise<ReconciliationExecutionResult> {
    if ((windowStart === undefined) !== (windowEnd === undefined)) {
      throw new BadRequestException(
        'windowStart and windowEnd must be provided together',
      );
    }

    if (windowStart === undefined || windowEnd === undefined) {
      const currentDay = new Date();
      windowEnd = new Date(
        Date.UTC(
          currentDay.getUTCFullYear(),
          currentDay.getUTCMonth(),
          currentDay.getUTCDate(),
        ),
      );
      windowStart = new Date(windowEnd);
      windowStart.setUTCDate(windowStart.getUTCDate() - 1);
    }

    if (
      Number.isNaN(windowStart.getTime()) ||
      Number.isNaN(windowEnd.getTime()) ||
      windowStart >= windowEnd
    ) {
      throw new BadRequestException(
        'Reconciliation window must have start before end',
      );
    }

    const result = await this.reconcileWindow(
      windowStart,
      windowEnd,
      'manual',
    );
    if (!result) {
      throw new ConflictException(
        'A reconciliation run already exists for the requested window',
      );
    }
    return result;
  }

  async recoverMissedUtcDays(
    now = new Date(),
    lookbackDays = RECONCILIATION_RECOVERY_LOOKBACK_DAYS,
  ): Promise<ReconciliationRecoverySummary> {
    const windows = getRecoveryUtcDailyWindows(now, lookbackDays);
    const summary: ReconciliationRecoverySummary = {
      windowsScanned: windows.length,
      recovered: 0,
      skipped: 0,
      failed: 0,
    };

    for (const { windowStart, windowEnd } of windows) {
      try {
        const result = await this.reconcileWindow(
          windowStart,
          windowEnd,
          'cron',
        );

        if (result) {
          summary.recovered += 1;
        } else {
          summary.skipped += 1;
        }
      } catch (error) {
        summary.failed += 1;
        this.logger.error(
          `Missed-window recovery failed for [${windowStart.toISOString()}, ${windowEnd.toISOString()})`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return summary;
  }

  async reconcileWindow(
    windowStart: Date,
    windowEnd: Date,
    triggerType: ReconciliationTriggerType,
  ): Promise<ReconciliationExecutionResult | null> {
    const claim =
      triggerType === 'cron'
        ? await this.repository.claimRecoveryWindow(windowStart, windowEnd)
        : await this.repository.claimManualWindow(windowStart, windowEnd);

    if (claim.outcome !== 'claimed' || !claim.run) {
      return null;
    }

    const run = claim.run;

    try {
      const records = await this.repository.findReconciliationData(
        windowStart,
        windowEnd,
      );
      const { counters, discrepancyBreakdown } =
        this.calculateCounts(records);
      const completedRun = await this.repository.completeRun(
        run.id,
        counters,
        records,
      );

      return {
        run: completedRun,
        counters,
        discrepancyBreakdown,
      };
    } catch (error) {
      try {
        await this.repository.markRunFailed(run.id, this.getErrorMessage(error));
      } catch (failureError) {
        throw new AggregateError(
          [error, failureError],
          `Reconciliation run "${run.id}" failed and could not be marked failed`,
        );
      }

      throw error;
    }
  }

  private calculateCounts(records: CodReconciliationRecordItem[]): ReconciliationCounts {
    const counters: ReconciliationRunCounters = {
      processedCount: records.length,
      matchedCount: 0,
      discrepancyCount: 0,
      uncollectedCount: 0,
    };
    const discrepancyBreakdown: ReconciliationDiscrepancyBreakdown = {
      missingCollections: 0,
      amountMismatches: 0,
      currencyMismatches: 0,
    };

    for (const record of records) {
      if (!record.discrepancy) {
        if (record.discrepancyType !== null) {
          throw new Error(
            'Reconciliation record has a discrepancy type but is marked matched',
          );
        }
        counters.matchedCount += 1;
        continue;
      }

      counters.discrepancyCount += 1;

      switch (record.discrepancyType) {
        case 'missing-collection':
          discrepancyBreakdown.missingCollections += 1;
          counters.uncollectedCount += 1;
          break;
        case 'amount-mismatch':
          discrepancyBreakdown.amountMismatches += 1;
          break;
        case 'currency-mismatch':
          discrepancyBreakdown.currencyMismatches += 1;
          break;
        default:
          throw new Error(
            'Reconciliation record is marked discrepant without a supported discrepancy type',
          );
      }
    }

    return { counters, discrepancyBreakdown };
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return typeof error === 'string'
      ? error
      : 'Reconciliation failed with a non-Error value';
  }
}
