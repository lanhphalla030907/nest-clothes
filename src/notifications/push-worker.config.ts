/**
 * Worker configuration read once at startup.
 *
 * All values are optional with safe defaults so the worker can run in any
 * environment without explicit tuning.
 */

const readNonEmpty = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const readPositiveInt = (value: string | undefined, fallback: number): number => {
  const raw = readNonEmpty(value);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const readBackoffSeconds = (
  value: string | undefined,
  fallback: number[],
): number[] => {
  const raw = readNonEmpty(value);
  if (raw === null) return fallback;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const parsed = parts.map((s) => Number.parseInt(s, 10));
  if (parsed.length === 0 || parsed.some((n) => !Number.isFinite(n) || n <= 0)) {
    return fallback;
  }
  return parsed;
};

export interface PushWorkerConfig {
  /** How long a lease stays valid before the sweeper can recover it. Default 60s. */
  readonly leaseTtlSeconds: number;
  /** How often the poll loop checks for due jobs. Default 5000ms. */
  readonly pollIntervalMs: number;
  /** How often the lease sweeper runs. Default 30000ms. */
  readonly leaseSweepIntervalMs: number;
  /** Maximum jobs claimed per poll cycle. Default 20. */
  readonly batchSize: number;
  /** Backoff seconds for consumed attempts 1..4. Default [60, 300, 1800, 7200]. */
  readonly retryBackoffSeconds: number[];
}

export const readPushWorkerConfig = (
  env: NodeJS.ProcessEnv = process.env,
): PushWorkerConfig => ({
  leaseTtlSeconds: readPositiveInt(env.PUSH_WORKER_LEASE_TTL_SECONDS, 60),
  pollIntervalMs: readPositiveInt(env.PUSH_WORKER_POLL_INTERVAL_MS, 5000),
  leaseSweepIntervalMs: readPositiveInt(
    env.PUSH_WORKER_LEASE_SWEEP_INTERVAL_MS,
    30000,
  ),
  batchSize: readPositiveInt(env.PUSH_WORKER_BATCH_SIZE, 20),
  retryBackoffSeconds: readBackoffSeconds(
    env.PUSH_RETRY_BACKOFF_SECONDS,
    [60, 300, 1800, 7200],
  ),
});
