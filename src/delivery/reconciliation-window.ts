export const RECONCILIATION_RECOVERY_LOOKBACK_DAYS = 30;

export interface ReconciliationUtcWindow {
  windowStart: Date;
  windowEnd: Date;
}

/**
 * Returns the completed UTC daily windows eligible for recovery, oldest first.
 *
 * The current UTC day is always excluded: every returned window ends at or
 * before the current UTC midnight. Windows are built from UTC calendar dates,
 * so local timezone and daylight-saving changes cannot alter their length.
 */
export function getRecoveryUtcDailyWindows(
  now = new Date(),
  lookbackDays = RECONCILIATION_RECOVERY_LOOKBACK_DAYS,
): ReconciliationUtcWindow[] {
  if (!Number.isSafeInteger(lookbackDays) || lookbackDays < 1) {
    throw new RangeError('Recovery lookback must be a positive integer');
  }

  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const windows: ReconciliationUtcWindow[] = [];

  for (let offset = lookbackDays; offset >= 1; offset -= 1) {
    const windowStart = new Date(todayStart);
    windowStart.setUTCDate(windowStart.getUTCDate() - offset);
    const windowEnd = new Date(windowStart);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + 1);
    windows.push({ windowStart, windowEnd });
  }

  return windows;
}
