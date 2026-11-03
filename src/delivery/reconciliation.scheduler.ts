import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { ReconciliationService } from './reconciliation.service.js';

export const COD_RECONCILIATION_CRON = 'cod-reconciliation-daily';
export const COD_RECONCILIATION_CRON_EXPRESSION = '0 0 1 * * *';
export const COD_RECONCILIATION_RECOVERY_INTERVAL =
  'cod-reconciliation-recovery';
export const COD_RECONCILIATION_RECOVERY_INTERVAL_MS = 10 * 60 * 1000;

export function getPreviousUtcCalendarDayWindow(now = new Date()): {
  windowStart: Date;
  windowEnd: Date;
} {
  const windowEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const windowStart = new Date(windowEnd);
  windowStart.setUTCDate(windowStart.getUTCDate() - 1);
  return { windowStart, windowEnd };
}

@Injectable()
export class ReconciliationScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReconciliationScheduler.name);
  private currentRecovery: Promise<void> | null = null;

  constructor(private readonly reconciliationService: ReconciliationService) {}

  /**
   * Starts recovery without awaiting it, so application startup and HTTP
   * readiness are never blocked by a backlog sweep.
   */
  onApplicationBootstrap(): void {
    void this.runRecovery('startup');
  }

  /**
   * Waits for the currently active recovery sweep, if any. Primarily useful for
   * tests and operational shutdown coordination.
   */
  async waitForRecovery(): Promise<void> {
    await this.currentRecovery;
  }

  @Cron(COD_RECONCILIATION_CRON_EXPRESSION, {
    name: COD_RECONCILIATION_CRON,
    timeZone: 'UTC',
  })
  async reconcilePreviousUtcDay(): Promise<void> {
    // The daily trigger uses the same idempotent catch-up operation as startup
    // and the periodic sweep. This avoids a separate single-window code path.
    await this.runRecovery('daily-cron');
  }

  @Interval(
    COD_RECONCILIATION_RECOVERY_INTERVAL,
    COD_RECONCILIATION_RECOVERY_INTERVAL_MS,
  )
  async recoverMissedWindows(): Promise<void> {
    await this.runRecovery('periodic');
  }

  private runRecovery(source: 'startup' | 'daily-cron' | 'periodic'): Promise<void> {
    if (this.currentRecovery) {
      this.logger.log(
        `Skipping ${source} COD reconciliation recovery because a sweep is already running`,
      );
      return this.currentRecovery;
    }

    const promise = this.executeRecovery(source).finally(() => {
      if (this.currentRecovery === promise) {
        this.currentRecovery = null;
      }
    });
    this.currentRecovery = promise;
    return promise;
  }

  private async executeRecovery(
    source: 'startup' | 'daily-cron' | 'periodic',
  ): Promise<void> {
    try {
      const summary =
        await this.reconciliationService.recoverMissedUtcDays();
      this.logger.log(
        `${source} COD reconciliation recovery scanned ${summary.windowsScanned} windows: ` +
          `${summary.recovered} recovered, ${summary.skipped} skipped, ${summary.failed} failed`,
      );
    } catch (error) {
      this.logger.error(
        `${source} COD reconciliation recovery failed`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
