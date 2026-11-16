import { describe, expect, it } from 'vitest';
import { readPushWorkerConfig } from './push-worker.config.js';

describe('readPushWorkerConfig', () => {
  it('returns defaults when no env vars are set', () => {
    const config = readPushWorkerConfig({});
    expect(config.leaseTtlSeconds).toBe(60);
    expect(config.pollIntervalMs).toBe(5000);
    expect(config.leaseSweepIntervalMs).toBe(30000);
    expect(config.batchSize).toBe(20);
    expect(config.retryBackoffSeconds).toEqual([60, 300, 1800, 7200]);
  });

  it('reads custom values from env', () => {
    const config = readPushWorkerConfig({
      PUSH_WORKER_LEASE_TTL_SECONDS: '120',
      PUSH_WORKER_POLL_INTERVAL_MS: '10000',
      PUSH_WORKER_LEASE_SWEEP_INTERVAL_MS: '60000',
      PUSH_WORKER_BATCH_SIZE: '50',
      PUSH_RETRY_BACKOFF_SECONDS: '30,120,600',
    });
    expect(config.leaseTtlSeconds).toBe(120);
    expect(config.pollIntervalMs).toBe(10000);
    expect(config.leaseSweepIntervalMs).toBe(60000);
    expect(config.batchSize).toBe(50);
    expect(config.retryBackoffSeconds).toEqual([30, 120, 600]);
  });

  it('falls back on invalid values', () => {
    const config = readPushWorkerConfig({
      PUSH_WORKER_LEASE_TTL_SECONDS: 'abc',
      PUSH_WORKER_POLL_INTERVAL_MS: '-5',
      PUSH_WORKER_LEASE_SWEEP_INTERVAL_MS: '0',
      PUSH_WORKER_BATCH_SIZE: '',
      PUSH_RETRY_BACKOFF_SECONDS: 'invalid',
    });
    expect(config.leaseTtlSeconds).toBe(60);
    expect(config.pollIntervalMs).toBe(5000);
    expect(config.leaseSweepIntervalMs).toBe(30000);
    expect(config.batchSize).toBe(20);
    expect(config.retryBackoffSeconds).toEqual([60, 300, 1800, 7200]);
  });

  it('trims whitespace from env values', () => {
    const config = readPushWorkerConfig({
      PUSH_WORKER_LEASE_TTL_SECONDS: ' 90 ',
      PUSH_RETRY_BACKOFF_SECONDS: ' 10, 20 ',
    });
    expect(config.leaseTtlSeconds).toBe(90);
    expect(config.retryBackoffSeconds).toEqual([10, 20]);
  });
});
