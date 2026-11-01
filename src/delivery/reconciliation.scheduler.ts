import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ReconciliationService } from './reconciliation.service.js';

export const COD_RECONCILIATION_CRON = 'cod-reconciliation-daily';
export const COD_RECONCILIATION_CRON_EXPRESSION = '0 0 1 * * *';

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
export class ReconciliationScheduler {
  private readonly logger = new Logger(ReconciliationScheduler.name);

  constructor(private readonly reconciliationService: ReconciliationService) {}

  @Cron(COD_RECONCILIATION_CRON_EXPRESSION, {
    name: COD_RECONCILIATION_CRON,
    timeZone: 'UTC',
  })
  async reconcilePreviousUtcDay(): Promise<void> {
    const { windowStart, windowEnd } = getPreviousUtcCalendarDayWindow();
    this.logger.log(
      `Starting scheduled COD reconciliation for [${windowStart.toISOString()}, ${windowEnd.toISOString()})`,
    );

    try {
      const result = await this.reconciliationService.reconcileWindow(
        windowStart,
        windowEnd,
        'cron',
      );

      if (!result) {
        this.logger.warn(
          `Skipped duplicate scheduled COD reconciliation for [${windowStart.toISOString()}, ${windowEnd.toISOString()})`,
        );
        return;
      }

      this.logger.log(
        `Completed scheduled COD reconciliation run ${result.run.id}`,
      );
    } catch (error) {
      this.logger.error(
        `Scheduled COD reconciliation failed for [${windowStart.toISOString()}, ${windowEnd.toISOString()})`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
