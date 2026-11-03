import { spawn, type ChildProcess } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Test, TestingModule } from '@nestjs/testing';
import { Client } from 'pg';
import { DeliveryRepository } from '../src/delivery/repositories/delivery.repository.js';
import {
  RECONCILIATION_STALE_RUN_ERROR,
  RECONCILIATION_STALE_RUN_THRESHOLD_MS,
  ReconciliationRepository,
  type ReconciliationRunClaimOutcome,
} from '../src/delivery/repositories/reconciliation.repository.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const WORKER_ENV = 'RECONCILIATION_CROSS_PROCESS_WORKER';
const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const integrationTestPath = fileURLToPath(import.meta.url);
const MAX_DIAGNOSTICS_LENGTH = 16_000;

type WorkerOperation = 'manual' | 'recovery';

interface WorkerResult {
  pid: number;
  outcome: ReconciliationRunClaimOutcome;
  runId: string | null;
  runTriggerType: string | null;
  runStatus: string | null;
  staleRunStatus?: string | null;
  staleRunError?: string | null;
}

interface WorkerProcess {
  child: ChildProcess;
  resultPath: string;
  stdout: string;
  stderr: string;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

interface Window {
  start: Date;
  end: Date;
}

const isWorker = process.env[WORKER_ENV] === '1';

describe('ReconciliationRepository cross-process integration', () => {
  if (isWorker) {
    it('cross-process repository worker', async () => {
      await runRepositoryWorker();
    }, 60_000);
    return;
  }

  const activeWorkers = new Set<WorkerProcess>();
  const coordinationClients = new Set<Client>();
  const usedWindowStarts = new Set<string>();
  const windows: Window[] = [];

  let module: TestingModule | undefined;
  let prisma: PrismaService | undefined;
  let repository: ReconciliationRepository | undefined;
  let workerTempDirectory: string | undefined;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is not set for cross-process integration tests',
      );
    }

    module = await Test.createTestingModule({
      providers: [PrismaService, DeliveryRepository, ReconciliationRepository],
    }).compile();
    const prismaService = module.get(PrismaService);
    prisma = prismaService;
    repository = module.get(ReconciliationRepository);
    await prismaService.$connect();

    workerTempDirectory = await mkdtemp(
      join(tmpdir(), 'reconciliation-cross-process-'),
    );
  });

  afterEach(async () => {
    try {
      await terminateActiveWorkers();
    } finally {
      try {
        await closeCoordinationClients();
      } finally {
        await cleanupRuns();
      }
    }
  });

  afterAll(async () => {
    try {
      await terminateActiveWorkers();
      await closeCoordinationClients();
      await cleanupRuns();
    } finally {
      try {
        await prisma?.$disconnect();
        await module?.close();
      } finally {
        if (workerTempDirectory) {
          await rm(workerTempDirectory, { recursive: true, force: true });
        }
      }
    }
  });

  it('allows exactly one of two independent recovery processes to claim a window', async () => {
    const window = createUniqueWindow();
    const barrier = await startWorkers(window, [
      { id: 'recovery-a', operation: 'recovery' },
      { id: 'recovery-b', operation: 'recovery' },
    ]);

    await releaseWorkers(barrier);
    const results = await readWorkerResults(barrier.workers);
    expect(new Set(results.map((result) => result.pid)).size).toBe(2);
    expect(results.map((result) => result.pid)).not.toContain(process.pid);
    expect(results.map((result) => result.pid)).toEqual(
      barrier.workers.map((worker) => worker.child.pid),
    );
    expect(
      results.filter((result) => result.outcome === 'claimed'),
    ).toHaveLength(1);
    expect(results.filter((result) => result.outcome === 'busy')).toHaveLength(
      1,
    );

    const activeCronRuns = await prisma!.codReconciliationRun.findMany({
      where: {
        windowStart: window.start,
        windowEnd: window.end,
        triggerType: 'cron',
        status: 'running',
      },
    });
    expect(activeCronRuns).toHaveLength(1);
    expect(
      await prisma!.codReconciliationRun.count({
        where: {
          windowStart: window.start,
          windowEnd: window.end,
          status: 'running',
        },
      }),
    ).toBe(1);
  }, 90_000);

  it('serializes manual and recovery claims across independent processes', async () => {
    const window = createUniqueWindow();
    const barrier = await startWorkers(window, [
      { id: 'manual-claimant', operation: 'manual' },
      { id: 'recovery-claimant', operation: 'recovery' },
    ]);

    await releaseWorkers(barrier);
    const results = await readWorkerResults(barrier.workers);
    expect(new Set(results.map((result) => result.pid)).size).toBe(2);
    expect(results.map((result) => result.pid)).not.toContain(process.pid);
    expect(results.map((result) => result.pid)).toEqual(
      barrier.workers.map((worker) => worker.child.pid),
    );
    expect(
      results.filter((result) => result.outcome === 'claimed'),
    ).toHaveLength(1);
    expect(results.filter((result) => result.outcome === 'busy')).toHaveLength(
      1,
    );

    const activeRuns = await prisma!.codReconciliationRun.findMany({
      where: {
        windowStart: window.start,
        windowEnd: window.end,
        status: 'running',
      },
    });
    expect(activeRuns).toHaveLength(1);

    const claimant = results.find((result) => result.outcome === 'claimed')!;
    expect(claimant.runId).toBe(activeRuns[0]!.id);
    expect(activeRuns[0]!.triggerType).toBe(claimant.runTriggerType);
  }, 90_000);

  it('releases its advisory lock after the child and its PostgreSQL transaction terminate', async () => {
    const window = createUniqueWindow();
    const lockKey = reconciliationLockKey(window);
    const barrier = await startWorkers(window, [
      { id: 'terminated-claimant', operation: 'recovery' },
    ]);
    const tableLockClient = await openCoordinationClient();
    let tableLockHeld = false;

    try {
      await tableLockClient.query('BEGIN');
      await tableLockClient.query(
        'LOCK TABLE "cod_reconciliation_runs" IN ACCESS EXCLUSIVE MODE',
      );
      tableLockHeld = true;

      await releaseWorkers(barrier);
      const backendPid = await waitForAdvisoryLockWaitingOnTable(
        barrier.coordinator,
        lockKey,
        barrier.workers,
      );

      await terminateWorker(barrier.workers[0]!, true);
      await barrier.coordinator.query(
        `SELECT pg_terminate_backend($1)
           WHERE EXISTS (
             SELECT 1
             FROM pg_locks
             WHERE pid = $1
               AND locktype = 'advisory'
               AND granted
               AND classid =
                 (((hashtextextended($2::text, 0) >> 32) & 4294967295)::oid)
               AND objid =
                 ((hashtextextended($2::text, 0) & 4294967295)::oid)
               AND objsubid = 1
           )`,
        [backendPid, lockKey],
      );
      await waitForAdvisoryLockCount(barrier.coordinator, lockKey, 0);

      await tableLockClient.query('ROLLBACK');
      tableLockHeld = false;

      const retry = await repository!.claimRecoveryWindow(
        window.start,
        window.end,
      );
      expect(retry.outcome).toBe('claimed');
      expect(retry.run).toMatchObject({
        triggerType: 'cron',
        status: 'running',
        windowStart: window.start,
        windowEnd: window.end,
      });
    } finally {
      if (tableLockHeld) {
        await tableLockClient.query('ROLLBACK');
      }
    }
  }, 90_000);

  it('recognizes completed-window coverage from another process', async () => {
    const window = createUniqueWindow();
    const completed = await repository!.createRun(
      'manual',
      window.start,
      window.end,
    );
    if (!completed) {
      throw new Error('Failed to create completed-window fixture');
    }
    await repository!.completeRun(completed.id, {
      processedCount: 0,
      matchedCount: 0,
      discrepancyCount: 0,
      uncollectedCount: 0,
    });
    await prisma!.codReconciliationRun.update({
      where: { id: completed.id },
      data: { completedAt: new Date(window.end.getTime() + 1_000) },
    });

    const barrier = await startWorkers(window, [
      { id: 'coverage-checker', operation: 'recovery' },
    ]);
    await releaseWorkers(barrier);
    const [result] = await readWorkerResults(barrier.workers);

    expect(result).toMatchObject({
      outcome: 'covered',
      runId: completed.id,
      runTriggerType: 'manual',
      runStatus: 'completed',
    });
  }, 90_000);

  it('fails a stale running attempt and claims recovery from another process', async () => {
    const window = createUniqueWindow();
    const stale = await repository!.createRun('cron', window.start, window.end);
    expect(stale).not.toBeNull();
    await prisma!.codReconciliationRun.update({
      where: { id: stale!.id },
      data: {
        startedAt: new Date(
          Date.now() - RECONCILIATION_STALE_RUN_THRESHOLD_MS - 60_000,
        ),
      },
    });

    const barrier = await startWorkers(
      window,
      [{ id: 'stale-recovery', operation: 'recovery' }],
      stale!.id,
    );
    await releaseWorkers(barrier);
    const [result] = await readWorkerResults(barrier.workers);

    expect(result).toMatchObject({
      outcome: 'claimed',
      runTriggerType: 'cron',
      runStatus: 'running',
      staleRunStatus: 'failed',
      staleRunError: RECONCILIATION_STALE_RUN_ERROR,
    });
    expect(result.runId).not.toBe(stale!.id);
  }, 90_000);

  function createUniqueWindow(): Window {
    let start: Date;
    do {
      start = new Date(Date.UTC(2200, 0, 1 + randomInt(0, 365)));
    } while (usedWindowStarts.has(start.toISOString()));

    usedWindowStarts.add(start.toISOString());
    const window = {
      start,
      end: new Date(start.getTime() + 24 * 60 * 60 * 1_000),
    };
    windows.push(window);
    return window;
  }

  async function startWorkers(
    window: Window,
    specs: Array<{ id: string; operation: WorkerOperation }>,
    staleRunId?: string,
  ) {
    const channel = `reconcile_${randomUUID().replaceAll('-', '')}`;
    const coordinator = await openCoordinationClient();
    await coordinator.query(`LISTEN "${channel}"`);

    const ready = waitForReadyNotifications(
      coordinator,
      channel,
      specs.map((spec) => spec.id),
    );
    const workers = specs.map((spec) =>
      spawnWorker(channel, spec.id, spec.operation, window, staleRunId),
    );

    return {
      coordinator,
      workers,
      ready,
      release: async () => {
        await ready;
        await coordinator.query('SELECT pg_notify($1, $2)', [channel, 'start']);
      },
    };
  }

  async function releaseWorkers(
    barrier: Awaited<ReturnType<typeof startWorkers>>,
  ): Promise<void> {
    try {
      await barrier.release();
    } catch (error) {
      throw new Error(
        `Child workers did not reach the PostgreSQL start barrier.\n${workerDiagnostics(barrier.workers)}\n${String(error)}`,
      );
    }
  }

  function spawnWorker(
    channel: string,
    workerId: string,
    operation: WorkerOperation,
    window: Window,
    staleRunId?: string,
  ): WorkerProcess {
    if (!workerTempDirectory || !process.env.DATABASE_URL) {
      throw new Error('Cross-process test fixtures are not initialized');
    }

    const testDatabaseUrl = new URL(process.env.DATABASE_URL);
    const workerBaseUrl = new URL(testDatabaseUrl);
    workerBaseUrl.pathname = `${workerBaseUrl.pathname}_worker_base`;
    const resultPath = join(
      workerTempDirectory,
      `${workerId}-${randomUUID()}.json`,
    );
    const testPath = relative(backendRoot, integrationTestPath);
    const vitestCli = resolve(
      backendRoot,
      'node_modules',
      'vitest',
      'vitest.mjs',
    );
    const child = spawn(
      process.execPath,
      [
        vitestCli,
        'run',
        testPath,
        '--config',
        'vitest.config.delivery-integration.ts',
        '--pool=threads',
        '--maxWorkers=1',
        '--testNamePattern',
        'cross-process repository worker',
      ],
      {
        cwd: backendRoot,
        env: {
          ...process.env,
          DATABASE_URL: workerBaseUrl.toString(),
          TEST_DATABASE_URL: testDatabaseUrl.toString(),
          [WORKER_ENV]: '1',
          RECONCILIATION_WORKER_CHANNEL: channel,
          RECONCILIATION_WORKER_ID: workerId,
          RECONCILIATION_WORKER_OPERATION: operation,
          RECONCILIATION_WINDOW_START: window.start.toISOString(),
          RECONCILIATION_WINDOW_END: window.end.toISOString(),
          RECONCILIATION_RESULT_PATH: resultPath,
          ...(staleRunId ? { RECONCILIATION_STALE_RUN_ID: staleRunId } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const worker: WorkerProcess = {
      child,
      resultPath,
      stdout: '',
      stderr: '',
      closed: Promise.resolve({ code: null, signal: null }),
    };
    worker.closed = new Promise((resolveClosed, rejectClosed) => {
      child.once('error', rejectClosed);
      child.once('close', (code, signal) => {
        activeWorkers.delete(worker);
        resolveClosed({ code, signal });
      });
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      worker.stdout = appendDiagnostic(worker.stdout, chunk.toString());
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      worker.stderr = appendDiagnostic(worker.stderr, chunk.toString());
    });
    activeWorkers.add(worker);
    return worker;
  }

  async function readWorkerResults(
    workers: WorkerProcess[],
  ): Promise<WorkerResult[]> {
    return Promise.all(
      workers.map(async (worker) => {
        const exit = await waitForWorker(worker);
        expect(
          exit.code,
          `Child exited with signal ${exit.signal}.\n${formatDiagnostics(worker)}`,
        ).toBe(0);
        return JSON.parse(
          await readFile(worker.resultPath, 'utf8'),
        ) as WorkerResult;
      }),
    );
  }

  async function waitForWorker(
    worker: WorkerProcess,
    timeoutMs = 60_000,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    let timeoutId: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        worker.closed,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () =>
              reject(new Error(`Child process timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      await terminateWorker(worker);
      throw new Error(`${String(error)}\n${formatDiagnostics(worker)}`);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  async function terminateWorker(
    worker: WorkerProcess,
    force = false,
  ): Promise<void> {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
      await worker.closed;
      return;
    }

    worker.child.kill(force ? 'SIGKILL' : 'SIGTERM');
    if (force) {
      await worker.closed;
      return;
    }

    const graceful = await Promise.race([
      worker.closed.then(() => true),
      new Promise<false>((resolveGraceful) =>
        setTimeout(() => resolveGraceful(false), 5_000),
      ),
    ]);
    if (!graceful) {
      worker.child.kill('SIGKILL');
      await worker.closed;
    }
  }

  async function terminateActiveWorkers(): Promise<void> {
    await Promise.all(
      Array.from(activeWorkers, (worker) => terminateWorker(worker)),
    );
  }

  async function openCoordinationClient(): Promise<Client> {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    coordinationClients.add(client);
    return client;
  }

  async function closeCoordinationClients(): Promise<void> {
    const clients = Array.from(coordinationClients);
    coordinationClients.clear();
    for (const client of clients) {
      await client.end();
    }
  }

  async function cleanupRuns(): Promise<void> {
    if (!prisma || windows.length === 0) {
      return;
    }
    for (const window of windows) {
      const lockKey = reconciliationLockKey(window);
      await prisma.$queryRaw`
        SELECT pg_terminate_backend("pid")
        FROM pg_locks
        WHERE "locktype" = 'advisory'
          AND "granted"
          AND "pid" <> pg_backend_pid()
          AND "classid" =
            (((hashtextextended(${lockKey}::text, 0) >> 32) & 4294967295)::oid)
          AND "objid" =
            ((hashtextextended(${lockKey}::text, 0) & 4294967295)::oid)
          AND "objsubid" = 1
      `;
    }
    const where = {
      OR: windows.map(({ start, end }) => ({
        windowStart: start,
        windowEnd: end,
      })),
    };
    const runs = await prisma.codReconciliationRun.findMany({
      where,
      select: { id: true },
    });
    if (runs.length > 0) {
      await prisma.codReconciliationRunItem.deleteMany({
        where: { runId: { in: runs.map((run) => run.id) } },
      });
    }
    await prisma.codReconciliationRun.deleteMany({ where });
  }

  function waitForReadyNotifications(
    client: Client,
    channel: string,
    workerIds: string[],
  ): Promise<void> {
    const expected = new Set(workerIds);
    return new Promise((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => {
        cleanup();
        rejectReady(
          new Error('Timed out waiting for all child workers to be ready'),
        );
      }, 30_000);
      const onNotification = (message: {
        channel: string;
        payload?: string;
      }) => {
        if (
          message.channel !== channel ||
          !message.payload?.startsWith('ready:')
        ) {
          return;
        }
        expected.delete(message.payload.slice('ready:'.length));
        if (expected.size === 0) {
          cleanup();
          resolveReady();
        }
      };
      const onError = (error: Error) => {
        cleanup();
        rejectReady(error);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        client.off('notification', onNotification);
        client.off('error', onError);
      };

      client.on('notification', onNotification);
      client.on('error', onError);
    });
  }

  async function waitForAdvisoryLockWaitingOnTable(
    client: Client,
    lockKey: string,
    workers: WorkerProcess[],
  ): Promise<number> {
    let backendPid: number | undefined;
    await waitForDatabaseCondition(
      async () => {
        const result = await client.query<{ pid: number }>(
          `SELECT advisory_lock.pid
           FROM pg_locks advisory_lock
           WHERE advisory_lock.locktype = 'advisory'
             AND advisory_lock.granted
             AND advisory_lock.classid =
               (((hashtextextended($1::text, 0) >> 32) & 4294967295)::oid)
             AND advisory_lock.objid =
               ((hashtextextended($1::text, 0) & 4294967295)::oid)
             AND advisory_lock.objsubid = 1
             AND EXISTS (
               SELECT 1
               FROM pg_locks relation_lock
               WHERE relation_lock.pid = advisory_lock.pid
                 AND relation_lock.locktype = 'relation'
                 AND relation_lock.relation = 'cod_reconciliation_runs'::regclass
                 AND NOT relation_lock.granted
             )
           LIMIT 1`,
          [lockKey],
        );
        backendPid = result.rows[0]?.pid;
        return backendPid !== undefined;
      },
      `No child held the window advisory lock while waiting for the fixture table lock.\n${workerDiagnostics(workers)}`,
    );
    if (backendPid === undefined) {
      throw new Error('No PostgreSQL backend owns the child advisory lock');
    }
    return backendPid;
  }

  async function waitForAdvisoryLockCount(
    client: Client,
    lockKey: string,
    expectedCount: number,
  ): Promise<void> {
    try {
      await waitForDatabaseCondition(async () => {
        const result = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count
         FROM pg_locks
         WHERE locktype = 'advisory'
           AND granted
           AND classid =
             (((hashtextextended($1::text, 0) >> 32) & 4294967295)::oid)
           AND objid =
             ((hashtextextended($1::text, 0) & 4294967295)::oid)
           AND objsubid = 1`,
          [lockKey],
        );
        return result.rows[0]!.count === expectedCount;
      }, `Expected ${expectedCount} PostgreSQL advisory lock(s) for ${lockKey}`);
    } catch (error) {
      const owners = await client.query(
        `SELECT l.pid, l.mode, l.granted, a.state, a.wait_event_type,
                a.wait_event, left(a.query, 180) AS query
         FROM pg_locks l
         LEFT JOIN pg_stat_activity a USING (pid)
         WHERE l.locktype = 'advisory'
           AND l.classid =
             (((hashtextextended($1::text, 0) >> 32) & 4294967295)::oid)
           AND l.objid =
             ((hashtextextended($1::text, 0) & 4294967295)::oid)
           AND l.objsubid = 1`,
        [lockKey],
      );
      throw new Error(
        `${String(error)}\nAdvisory lock sessions: ${JSON.stringify(owners.rows)}`,
      );
    }
  }

  async function waitForDatabaseCondition(
    condition: () => Promise<boolean>,
    failureMessage: string,
  ): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await condition()) {
        return;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    throw new Error(failureMessage);
  }

  function reconciliationLockKey(window: Window): string {
    return `cod-reconciliation:${window.start.toISOString()}:${window.end.toISOString()}`;
  }

  function workerDiagnostics(workers: WorkerProcess[]): string {
    return workers.map(formatDiagnostics).join('\n\n');
  }

  function formatDiagnostics(worker: WorkerProcess): string {
    return [
      `Child PID: ${worker.child.pid ?? 'not started'}`,
      `stdout:\n${worker.stdout || '(empty)'}`,
      `stderr:\n${worker.stderr || '(empty)'}`,
    ].join('\n');
  }

  function appendDiagnostic(previous: string, next: string): string {
    return `${previous}${next}`.slice(-MAX_DIAGNOSTICS_LENGTH);
  }
});

async function runRepositoryWorker(): Promise<void> {
  const channel = requireWorkerEnv('RECONCILIATION_WORKER_CHANNEL');
  const workerId = requireWorkerEnv('RECONCILIATION_WORKER_ID');
  const operation = requireWorkerOperation();
  const windowStart = new Date(requireWorkerEnv('RECONCILIATION_WINDOW_START'));
  const windowEnd = new Date(requireWorkerEnv('RECONCILIATION_WINDOW_END'));
  const resultPath = requireWorkerEnv('RECONCILIATION_RESULT_PATH');
  const staleRunId = process.env.RECONCILIATION_STALE_RUN_ID;
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  let module: TestingModule | undefined;
  let prisma: PrismaService | undefined;

  try {
    module = await Test.createTestingModule({
      providers: [PrismaService, DeliveryRepository, ReconciliationRepository],
    }).compile();
    const prismaService = module.get(PrismaService);
    prisma = prismaService;
    const repository = module.get(ReconciliationRepository);
    await prismaService.$connect();

    await client.connect();
    await client.query(`LISTEN "${channel}"`);
    const startSignal = waitForStartSignal(client, channel);
    await client.query('SELECT pg_notify($1, $2)', [
      channel,
      `ready:${workerId}`,
    ]);
    await startSignal;

    const claim =
      operation === 'manual'
        ? await repository.claimManualWindow(windowStart, windowEnd)
        : await repository.claimRecoveryWindow(windowStart, windowEnd);
    const stale = staleRunId ? await repository.findRunById(staleRunId) : null;

    const result: WorkerResult = {
      pid: process.pid,
      outcome: claim.outcome,
      runId: claim.run?.id ?? null,
      runTriggerType: claim.run?.triggerType ?? null,
      runStatus: claim.run?.status ?? null,
      ...(staleRunId
        ? {
            staleRunStatus: stale?.status ?? null,
            staleRunError: stale?.errorMessage,
          }
        : {}),
    };
    await writeFile(resultPath, JSON.stringify(result), 'utf8');
  } finally {
    await client.end();
    await prisma?.$disconnect();
    await module?.close();
  }
}

function waitForStartSignal(client: Client, channel: string): Promise<void> {
  return new Promise((resolveStart, rejectStart) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectStart(
        new Error('Timed out waiting for parent PostgreSQL start signal'),
      );
    }, 30_000);
    const onNotification = (message: { channel: string; payload?: string }) => {
      if (message.channel === channel && message.payload === 'start') {
        cleanup();
        resolveStart();
      }
    };
    const onError = (error: Error) => {
      cleanup();
      rejectStart(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      client.off('notification', onNotification);
      client.off('error', onError);
    };

    client.on('notification', onNotification);
    client.on('error', onError);
  });
}

function requireWorkerEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing child worker environment variable ${name}`);
  }
  return value;
}

function requireWorkerOperation(): WorkerOperation {
  const operation = requireWorkerEnv('RECONCILIATION_WORKER_OPERATION');
  if (operation !== 'manual' && operation !== 'recovery') {
    throw new Error(`Unknown child worker operation: ${operation}`);
  }
  return operation;
}
