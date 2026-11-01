import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module.js';
import { DeliveryModule } from './delivery.module.js';
import { ReconciliationService } from './reconciliation.service.js';
import {
  COD_RECONCILIATION_CRON,
  COD_RECONCILIATION_CRON_EXPRESSION,
  getPreviousUtcCalendarDayWindow,
  ReconciliationScheduler,
} from './reconciliation.scheduler.js';

describe('ReconciliationScheduler', () => {
  it('declares a daily 01:00 UTC cron job', () => {
    const metadata = Reflect.getMetadata(
      'SCHEDULE_CRON_OPTIONS',
      ReconciliationScheduler.prototype.reconcilePreviousUtcDay,
    ) as Record<string, unknown>;

    expect(metadata).toMatchObject({
      cronTime: COD_RECONCILIATION_CRON_EXPRESSION,
      timeZone: 'UTC',
      name: COD_RECONCILIATION_CRON,
    });
  });

  it('calculates the previous UTC calendar day independent of local timezone', () => {
    const { windowStart, windowEnd } = getPreviousUtcCalendarDayWindow(
      new Date('2026-03-01T00:15:00.000+07:00'),
    );

    expect(windowStart.toISOString()).toBe('2026-02-27T00:00:00.000Z');
    expect(windowEnd.toISOString()).toBe('2026-02-28T00:00:00.000Z');
  });

  it('registers ScheduleModule once at the root and the scheduler in DeliveryModule', () => {
    const rootImports = Reflect.getMetadata('imports', AppModule) as Array<
      typeof ScheduleModule | { module?: typeof ScheduleModule }
    >;
    const schedulerRegistrations = rootImports.filter(
      (entry) =>
        entry === ScheduleModule ||
        (typeof entry === 'object' && entry.module === ScheduleModule),
    );
    const deliveryProviders = Reflect.getMetadata(
      'providers',
      DeliveryModule,
    ) as unknown[];

    expect(schedulerRegistrations).toHaveLength(1);
    expect(deliveryProviders).toContain(ReconciliationScheduler);
  });

  it('is discovered by Nest and invokes reconciliation when the registered job fires', async () => {
    const reconciliationService = {
      reconcileWindow: vi.fn().mockResolvedValue(null),
    };
    const module = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        ReconciliationScheduler,
        { provide: ReconciliationService, useValue: reconciliationService },
      ],
    }).compile();

    await module.init();

    try {
      expect(module.get(ReconciliationScheduler)).toBeInstanceOf(
        ReconciliationScheduler,
      );
      const registry = module.get(SchedulerRegistry);
      const job = registry.getCronJob(COD_RECONCILIATION_CRON);
      expect(job).toBeDefined();

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-03-01T22:15:00.000Z'));
      await job.fireOnTick();

      expect(reconciliationService.reconcileWindow).toHaveBeenCalledWith(
        new Date('2026-02-28T00:00:00.000Z'),
        new Date('2026-03-01T00:00:00.000Z'),
        'cron',
      );
    } finally {
      vi.useRealTimers();
      await module.close();
    }
  });

  it('logs duplicate skips and absorbs reconciliation failures', async () => {
    const reconciliationService = {
      reconcileWindow: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('database unavailable')),
    };
    const module = await Test.createTestingModule({
      providers: [
        ReconciliationScheduler,
        { provide: ReconciliationService, useValue: reconciliationService },
      ],
    }).compile();
    const scheduler = module.get(ReconciliationScheduler);

    await expect(scheduler.reconcilePreviousUtcDay()).resolves.toBeUndefined();
    await expect(scheduler.reconcilePreviousUtcDay()).resolves.toBeUndefined();
    expect(reconciliationService.reconcileWindow).toHaveBeenCalledTimes(2);
  });
});
