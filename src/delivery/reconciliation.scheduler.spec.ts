import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module.js';
import { DeliveryModule } from './delivery.module.js';
import { ReconciliationService } from './reconciliation.service.js';
import {
  COD_RECONCILIATION_CRON,
  COD_RECONCILIATION_CRON_EXPRESSION,
  COD_RECONCILIATION_RECOVERY_INTERVAL,
  COD_RECONCILIATION_RECOVERY_INTERVAL_MS,
  getPreviousUtcCalendarDayWindow,
  ReconciliationScheduler,
} from './reconciliation.scheduler.js';

const summary = {
  windowsScanned: 30,
  recovered: 0,
  skipped: 30,
  failed: 0,
};

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

  it('declares a ten-minute named recovery interval', () => {
    const metadata = Reflect.getMetadata(
      'SCHEDULE_INTERVAL_OPTIONS',
      ReconciliationScheduler.prototype.recoverMissedWindows,
    ) as Record<string, unknown>;
    const name = Reflect.getMetadata(
      'SCHEDULER_NAME',
      ReconciliationScheduler.prototype.recoverMissedWindows,
    ) as string;

    expect(metadata).toEqual({ timeout: 600_000 });
    expect(COD_RECONCILIATION_RECOVERY_INTERVAL_MS).toBe(600_000);
    expect(name).toBe(COD_RECONCILIATION_RECOVERY_INTERVAL);
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

  it('runs recovery during application bootstrap without blocking initialization', async () => {
    let resolveRecovery!: (value: typeof summary) => void;
    const pending = new Promise<typeof summary>((resolve) => {
      resolveRecovery = resolve;
    });
    const reconciliationService = {
      recoverMissedUtcDays: vi.fn().mockReturnValue(pending),
    };
    const module = await Test.createTestingModule({
      providers: [
        ReconciliationScheduler,
        { provide: ReconciliationService, useValue: reconciliationService },
      ],
    }).compile();
    const scheduler = module.get(ReconciliationScheduler);

    await expect(module.init()).resolves.toBeDefined();
    expect(reconciliationService.recoverMissedUtcDays).toHaveBeenCalledOnce();

    resolveRecovery(summary);
    await scheduler.waitForRecovery();
    await module.close();
  });

  it('uses the same recovery operation from the daily cron job', async () => {
    const reconciliationService = {
      recoverMissedUtcDays: vi.fn().mockResolvedValue(summary),
    };
    const module = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        ReconciliationScheduler,
        { provide: ReconciliationService, useValue: reconciliationService },
      ],
    }).compile();

    await module.init();
    const scheduler = module.get(ReconciliationScheduler);
    await scheduler.waitForRecovery();
    reconciliationService.recoverMissedUtcDays.mockClear();

    try {
      const registry = module.get(SchedulerRegistry);
      const job = registry.getCronJob(COD_RECONCILIATION_CRON);
      expect(job).toBeDefined();

      await job.fireOnTick();

      expect(reconciliationService.recoverMissedUtcDays).toHaveBeenCalledOnce();
    } finally {
      await module.close();
    }
  });

  it('runs the periodic recovery operation', async () => {
    const reconciliationService = {
      recoverMissedUtcDays: vi.fn().mockResolvedValue(summary),
    };
    const module = await Test.createTestingModule({
      providers: [
        ReconciliationScheduler,
        { provide: ReconciliationService, useValue: reconciliationService },
      ],
    }).compile();
    const scheduler = module.get(ReconciliationScheduler);

    await expect(scheduler.recoverMissedWindows()).resolves.toBeUndefined();
    expect(reconciliationService.recoverMissedUtcDays).toHaveBeenCalledOnce();
    await module.close();
  });

  it('does not start overlapping recovery sweeps within one process', async () => {
    let resolveRecovery!: (value: typeof summary) => void;
    const pending = new Promise<typeof summary>((resolve) => {
      resolveRecovery = resolve;
    });
    const reconciliationService = {
      recoverMissedUtcDays: vi.fn().mockReturnValue(pending),
    };
    const module = await Test.createTestingModule({
      providers: [
        ReconciliationScheduler,
        { provide: ReconciliationService, useValue: reconciliationService },
      ],
    }).compile();
    const scheduler = module.get(ReconciliationScheduler);

    const first = scheduler.recoverMissedWindows();
    const second = scheduler.recoverMissedWindows();
    expect(reconciliationService.recoverMissedUtcDays).toHaveBeenCalledOnce();

    resolveRecovery(summary);
    await Promise.all([first, second]);
    await module.close();
  });

  it('absorbs recovery failures', async () => {
    const reconciliationService = {
      recoverMissedUtcDays: vi
        .fn()
        .mockRejectedValueOnce(new Error('database unavailable'))
        .mockResolvedValueOnce(summary),
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
    expect(reconciliationService.recoverMissedUtcDays).toHaveBeenCalledTimes(
      2,
    );
    await module.close();
  });
});
