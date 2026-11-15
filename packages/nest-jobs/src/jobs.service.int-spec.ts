import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import { Logger, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool, type PoolClient, type QueryResult } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

import type { JobQueueDeclaration } from './job-queue.js';
import type { Job, JobEnqueueResult, JobsTransaction } from './job.js';
import { JobsModule } from './jobs.module.js';
import { JobsService } from './jobs.service.js';
import { provisionJobs } from './provision-jobs.js';
import {
  APP_ROLE,
  queryAs,
  startJobsTestServer,
  waitFor,
  type JobsTestDatabase,
  type JobsTestServer,
} from './testing/jobs-database.js';

/**
 * Interface JobRow
 *
 * @description
 * The columns of a stored job these specs observe.
 */
interface JobRow {
  // #region Properties
  /**
   * Property id
   *
   * @description
   * Job id.
   *
   * @type {string}
   * @readonly
   */
  readonly id: string;

  /**
   * Property state
   *
   * @description
   * pg-boss job state.
   *
   * @type {string}
   * @readonly
   */
  readonly state: string;

  /**
   * Property retry_count
   *
   * @description
   * Retries consumed so far.
   *
   * @type {number}
   * @readonly
   */
  readonly retry_count: number;

  /**
   * Property data
   *
   * @description
   * Stored job data.
   *
   * @type {unknown}
   * @readonly
   */
  readonly data: unknown;

  /**
   * Property source_name
   *
   * @description
   * Queue a dead letter came from, or `null`.
   *
   * @type {string | null}
   * @readonly
   */
  readonly source_name: string | null;

  /**
   * Property source_id
   *
   * @description
   * Id of the job a dead letter was copied from, or `null`.
   *
   * @type {string | null}
   * @readonly
   */
  readonly source_id: string | null;

  /**
   * Property output
   *
   * @description
   * What pg-boss stored about the last failure of the job, or `null`.
   *
   * @type {unknown}
   * @readonly
   */
  readonly output: unknown;

  /**
   * Property source_output
   *
   * @description
   * On a dead letter, the stored failure of the job it was copied from, or `null`.
   *
   * @type {unknown}
   * @readonly
   */
  readonly source_output: unknown;
  // #endregion
}

/**
 * Interface OrganizationScope
 *
 * @description
 * What the test's `runInOrganization` stores around a handler call.
 */
interface OrganizationScope {
  // #region Properties
  /**
   * Property organizationId
   *
   * @description
   * Organization the handler runs for.
   *
   * @type {string | null}
   * @readonly
   */
  readonly organizationId: string | null;
  // #endregion
}

/**
 * Constant queues
 *
 * @description
 * Queues of the test service, one per scenario so the scenarios do not see each other's jobs. The
 * retrying queues use the shortest delay pg-boss stores, one second.
 *
 * @type {readonly JobQueueDeclaration[]}
 */
const queues: readonly JobQueueDeclaration[] = [
  { name: 'transactional' },
  { name: 'occurrences' },
  { name: 'occurrences-other' },
  { name: 'flaky', retryLimit: 2, retryDelaySeconds: 1 },
  { name: 'doomed', retryLimit: 2, retryDelaySeconds: 1 },
  { name: 'scoped' },
  { name: 'digests' },
  { name: 'slow', retryLimit: 0, expireInSeconds: 1 },
  { name: 'stuck', retryLimit: 0, expireInSeconds: 1 },
];

/**
 * Constant organizations
 *
 * @description
 * Stand-in for the organization context of an application.
 *
 * @type {AsyncLocalStorage<OrganizationScope>}
 */
const organizations: AsyncLocalStorage<OrganizationScope> =
  new AsyncLocalStorage<OrganizationScope>();

/**
 * Function messagesOf
 *
 * @description
 * Reads the messages a logger spy received.
 *
 * @param {MockInstance} spy - Spy on a logger method.
 * @returns {string[]} First argument of every call, as text.
 */
function messagesOf(spy: MockInstance): string[] {
  return spy.mock.calls.map((call: unknown[]): string => String(call[0]));
}

describe('JobsService', () => {
  let server: JobsTestServer;
  let database: JobsTestDatabase;
  let app: INestApplicationContext;
  let jobs: JobsService;
  let pool: Pool;

  /**
   * Function transact
   *
   * @description
   * Runs a use case in a transaction of the application pool, as the application role, and ends
   * it the way the scenario asks.
   *
   * @param {string | null} organizationId - Organization of the transaction scope.
   * @param {'COMMIT' | 'ROLLBACK'} end - How the transaction ends once the use case returned.
   * @param {(tx: JobsTransaction) => Promise<TResult>} useCase - Work done inside the transaction.
   * @returns {Promise<TResult>} What the use case returned.
   */
  async function transact<TResult>(
    organizationId: string | null,
    end: 'COMMIT' | 'ROLLBACK',
    useCase: (tx: JobsTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      const result: TResult = await useCase({ client, organizationId });
      await client.query(end);
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Function jobsOf
   *
   * @description
   * Reads the committed jobs of a queue as the superuser, oldest first.
   *
   * @param {string} queue - Queue name.
   * @returns {Promise<JobRow[]>} The stored jobs.
   */
  async function jobsOf(queue: string): Promise<JobRow[]> {
    const result: QueryResult<JobRow> = await queryAs<JobRow>(
      database.admin,
      `SELECT id, state::text AS state, retry_count, data, source_name, source_id, output,
              source_output
       FROM pgboss.job WHERE name = $1 ORDER BY created_on`,
      [queue],
    );
    return result.rows;
  }

  /**
   * Function stateOf
   *
   * @description
   * Reads the state of one stored job.
   *
   * @param {string} queue - Queue name.
   * @param {string} id - Job id.
   * @returns {Promise<string | undefined>} The pg-boss state, or `undefined` when the job is gone.
   */
  async function stateOf(queue: string, id: string): Promise<string | undefined> {
    const rows: JobRow[] = await jobsOf(queue);
    return rows.find((row: JobRow): boolean => row.id === id)?.state;
  }

  beforeAll(async () => {
    Logger.overrideLogger(false);
    server = await startJobsTestServer();
    database = await server.createDatabase();
    await provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues });
    app = await NestFactory.createApplicationContext(
      JobsModule.forRoot({
        connection: database.app,
        queues,
        runInOrganization: (organizationId: string | null, work: () => Promise<void>) =>
          organizations.run({ organizationId }, work),
      }),
      { logger: false, abortOnError: false },
    );
    jobs = app.get(JobsService);
    pool = new Pool({ ...database.app, max: 2 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
    await server.stop();
  });

  it('runs as the application role on a pool of two connections', async () => {
    const sessions: QueryResult<{ usename: string; count: number }> = await queryAs<{
      usename: string;
      count: number;
    }>(
      database.admin,
      `SELECT usename::text AS usename, count(*)::int AS count
       FROM pg_stat_activity
       WHERE datname = $1 AND application_name LIKE 'pgboss%'
       GROUP BY usename`,
      [database.name],
    );

    expect(sessions.rows).toHaveLength(1);
    expect(sessions.rows[0]?.usename).toBe(APP_ROLE);
    expect(sessions.rows[0]?.count).toBeGreaterThanOrEqual(1);
    expect(sessions.rows[0]?.count).toBeLessThanOrEqual(2);
  });

  it('leaves no job when the transaction rolls back and delivers the job once it commits', async () => {
    const received: Job<{ reminderId: string }>[] = [];
    await jobs.work<{ reminderId: string }>(
      'transactional',
      (job: Job<{ reminderId: string }>): Promise<void> => {
        received.push(job);
        return Promise.resolve();
      },
      { pollingIntervalSeconds: 0.5 },
    );

    const rolledBack: JobEnqueueResult = await transact(
      'org-1',
      'ROLLBACK',
      (tx: JobsTransaction) => jobs.enqueue(tx, 'transactional', { reminderId: 'r-0' }),
    );

    expect(rolledBack.duplicate).toBe(false);
    expect(await jobsOf('transactional')).toEqual([]);

    const committed: JobEnqueueResult = await transact(
      'org-1',
      'COMMIT',
      async (tx: JobsTransaction): Promise<JobEnqueueResult> => {
        const result: JobEnqueueResult = await jobs.enqueue(tx, 'transactional', {
          reminderId: 'r-1',
        });
        await sleep(1_500);
        expect(await jobsOf('transactional')).toEqual([]);
        expect(received).toEqual([]);
        return result;
      },
    );

    await waitFor((): boolean => received.length > 0, 10_000);
    await waitFor(
      async (): Promise<boolean> =>
        (await stateOf('transactional', committed.jobId)) === 'completed',
      10_000,
    );
    expect(received).toEqual([
      {
        id: committed.jobId,
        queue: 'transactional',
        payload: { reminderId: 'r-1' },
        organizationId: 'org-1',
        attempt: 1,
        signal: expect.any(AbortSignal) as AbortSignal,
      },
    ]);
    expect(received.map((job: Job): string => job.id)).not.toContain(rolledBack.jobId);
  });

  it('makes a second enqueue with the same occurrence key a no-op', async () => {
    const handled: string[] = [];
    const first: JobEnqueueResult = await transact(
      'org-1',
      'COMMIT',
      async (tx: JobsTransaction): Promise<JobEnqueueResult> => {
        const created: JobEnqueueResult = await jobs.enqueue(
          tx,
          'occurrences',
          { reminderId: 'r-1' },
          { occurrenceKey: 'r-1:1' },
        );
        const again: JobEnqueueResult = await jobs.enqueue(
          tx,
          'occurrences',
          { reminderId: 'r-1' },
          { occurrenceKey: 'r-1:1' },
        );
        expect(again).toEqual({ jobId: created.jobId, duplicate: true });
        return created;
      },
    );
    expect(first.duplicate).toBe(false);

    const second: JobEnqueueResult = await transact('org-1', 'COMMIT', (tx: JobsTransaction) =>
      jobs.enqueue(tx, 'occurrences', { reminderId: 'r-1' }, { occurrenceKey: 'r-1:1' }),
    );
    const nextOccurrence: JobEnqueueResult = await transact(
      'org-1',
      'COMMIT',
      (tx: JobsTransaction) =>
        jobs.enqueue(tx, 'occurrences', { reminderId: 'r-1' }, { occurrenceKey: 'r-1:2' }),
    );
    const otherQueue: JobEnqueueResult = await transact('org-1', 'COMMIT', (tx: JobsTransaction) =>
      jobs.enqueue(tx, 'occurrences-other', { reminderId: 'r-1' }, { occurrenceKey: 'r-1:1' }),
    );

    const otherOrganization: JobEnqueueResult = await transact(
      'org-2',
      'COMMIT',
      (tx: JobsTransaction) =>
        jobs.enqueue(tx, 'occurrences', { reminderId: 'r-1' }, { occurrenceKey: 'r-1:1' }),
    );
    const noOrganization: JobEnqueueResult = await transact(null, 'COMMIT', (tx: JobsTransaction) =>
      jobs.enqueue(tx, 'occurrences', { reminderId: 'r-1' }, { occurrenceKey: 'r-1:1' }),
    );

    expect(second).toEqual({ jobId: first.jobId, duplicate: true });
    expect(nextOccurrence.duplicate).toBe(false);
    expect(otherQueue.duplicate).toBe(false);
    expect(otherQueue.jobId).not.toBe(first.jobId);
    expect(otherOrganization.duplicate).toBe(false);
    expect(noOrganization.duplicate).toBe(false);
    expect((await jobsOf('occurrences')).map((row: JobRow): string => row.id).sort()).toEqual(
      [first.jobId, nextOccurrence.jobId, otherOrganization.jobId, noOrganization.jobId].sort(),
    );

    await jobs.work(
      'occurrences',
      (job: Job): Promise<void> => {
        handled.push(job.id);
        return Promise.resolve();
      },
      { pollingIntervalSeconds: 0.5 },
    );
    await waitFor(
      async (): Promise<boolean> => (await stateOf('occurrences', first.jobId)) === 'completed',
      10_000,
    );

    const afterCompletion: JobEnqueueResult = await transact(
      'org-1',
      'COMMIT',
      (tx: JobsTransaction) =>
        jobs.enqueue(tx, 'occurrences', { reminderId: 'r-1' }, { occurrenceKey: 'r-1:1' }),
    );
    await sleep(1_500);

    expect(afterCompletion).toEqual({ jobId: first.jobId, duplicate: true });
    expect(handled.filter((id: string): boolean => id === first.jobId)).toHaveLength(1);
  });

  it('does not keep the occurrence key of an enqueue that rolled back', async () => {
    const rolledBack: JobEnqueueResult = await transact(
      'org-1',
      'ROLLBACK',
      (tx: JobsTransaction) =>
        jobs.enqueue(tx, 'occurrences-other', {}, { occurrenceKey: 'r-9:1' }),
    );
    const retried: JobEnqueueResult = await transact('org-1', 'COMMIT', (tx: JobsTransaction) =>
      jobs.enqueue(tx, 'occurrences-other', {}, { occurrenceKey: 'r-9:1' }),
    );

    expect(rolledBack.duplicate).toBe(false);
    expect(retried).toEqual({ jobId: rolledBack.jobId, duplicate: false });
  });

  it('retries a failing handler after the queue delay until it succeeds', async () => {
    const warnings: MockInstance = vi.spyOn(Logger.prototype, 'warn');
    const errors: MockInstance = vi.spyOn(Logger.prototype, 'error');
    const startedAt: number[] = [];
    await jobs.work(
      'flaky',
      (job: Job): Promise<void> => {
        startedAt.push(Date.now());
        return job.attempt === 1
          ? Promise.reject(new Error('mail server unavailable'))
          : Promise.resolve();
      },
      { pollingIntervalSeconds: 0.5 },
    );

    const enqueued: JobEnqueueResult = await transact('org-1', 'COMMIT', (tx: JobsTransaction) =>
      jobs.enqueue(tx, 'flaky', { deliveryId: 'd-1' }),
    );
    await waitFor(
      async (): Promise<boolean> => (await stateOf('flaky', enqueued.jobId)) === 'completed',
      20_000,
    );

    expect(startedAt).toHaveLength(2);
    expect((startedAt[1] ?? 0) - (startedAt[0] ?? 0)).toBeGreaterThanOrEqual(950);
    expect(await jobsOf('flaky.dead-letter')).toEqual([]);
    expect(messagesOf(warnings)).toEqual([
      `Job ${enqueued.jobId} of queue "flaky" failed attempt 1 of 3 and will be retried: Error: mail server unavailable`,
    ]);
    expect(messagesOf(errors)).toEqual([]);
  });

  it('retries with backoff up to the limit, then dead-letters the job and logs an error', async () => {
    const warnings: MockInstance = vi.spyOn(Logger.prototype, 'warn');
    const errors: MockInstance = vi.spyOn(Logger.prototype, 'error');
    const attempts: number[] = [];
    const startedAt: number[] = [];
    await jobs.work(
      'doomed',
      (job: Job): Promise<void> => {
        attempts.push(job.attempt);
        startedAt.push(Date.now());
        return Promise.reject(
          Object.assign(new Error('smtp refused', { cause: new Error('cause-marker-77') }), {
            recipient: 'property-marker-41',
          }),
        );
      },
      { pollingIntervalSeconds: 0.5 },
    );

    const enqueued: JobEnqueueResult = await transact('org-1', 'COMMIT', (tx: JobsTransaction) =>
      jobs.enqueue(tx, 'doomed', { recipient: 'payload-marker-9f2' }),
    );
    await waitFor(
      async (): Promise<boolean> => (await jobsOf('doomed.dead-letter')).length > 0,
      40_000,
    );

    expect(attempts).toEqual([1, 2, 3]);
    expect((startedAt[1] ?? 0) - (startedAt[0] ?? 0)).toBeGreaterThanOrEqual(950);
    expect((startedAt[2] ?? 0) - (startedAt[1] ?? 0)).toBeGreaterThanOrEqual(1_950);
    expect(await jobsOf('doomed')).toMatchObject([
      { id: enqueued.jobId, state: 'failed', retry_count: 2 },
    ]);
    expect(await jobsOf('doomed.dead-letter')).toMatchObject([
      {
        state: 'created',
        data: { organizationId: 'org-1', payload: { recipient: 'payload-marker-9f2' } },
        source_name: 'doomed',
        source_id: enqueued.jobId,
      },
    ]);
    expect(messagesOf(errors)).toEqual([
      `Job ${enqueued.jobId} of queue "doomed" failed its last attempt (3 of 3) and moves to the dead-letter queue "doomed.dead-letter": Error: smtp refused`,
    ]);
    expect(messagesOf(warnings)).toEqual([
      `Job ${enqueued.jobId} of queue "doomed" failed attempt 1 of 3 and will be retried: Error: smtp refused`,
      `Job ${enqueued.jobId} of queue "doomed" failed attempt 2 of 3 and will be retried: Error: smtp refused`,
    ]);
    expect(JSON.stringify([...errors.mock.calls, ...warnings.mock.calls])).not.toContain(
      'payload-marker-9f2',
    );
    const failed: JobRow[] = await jobsOf('doomed');
    const deadLetters: JobRow[] = await jobsOf('doomed.dead-letter');
    for (const stored of [failed[0]?.output, deadLetters[0]?.source_output]) {
      expect(stored).toMatchObject({ name: 'Error', message: 'Error: smtp refused' });
      expect(Object.keys(stored as object).sort()).toEqual(['message', 'name', 'stack']);
      expect(JSON.stringify(stored)).not.toMatch(/property-marker-41|cause-marker-77/);
    }
  });

  it('aborts the signal of an attempt that outlives expireInSeconds and logs its dead letter', async () => {
    const errors: MockInstance = vi.spyOn(Logger.prototype, 'error');
    let startedAt: number = 0;
    let abortedAt: number = 0;
    await jobs.work(
      'slow',
      (job: Job): Promise<void> =>
        new Promise<void>((resolve: () => void): void => {
          startedAt = Date.now();
          job.signal.addEventListener(
            'abort',
            (): void => {
              abortedAt = Date.now();
              resolve();
            },
            { once: true },
          );
        }),
      { pollingIntervalSeconds: 0.5 },
    );

    const enqueued: JobEnqueueResult = await transact('org-1', 'COMMIT', (tx: JobsTransaction) =>
      jobs.enqueue(tx, 'slow', {}),
    );
    await waitFor(
      async (): Promise<boolean> => (await jobsOf('slow.dead-letter')).length > 0,
      20_000,
    );
    await waitFor((): boolean => abortedAt > 0, 5_000);

    expect(abortedAt - startedAt).toBeGreaterThanOrEqual(950);
    expect(abortedAt - startedAt).toBeLessThan(5_000);
    expect(await jobsOf('slow')).toMatchObject([{ id: enqueued.jobId, state: 'failed' }]);
    expect(
      messagesOf(errors).filter((message: string): boolean => message.includes(enqueued.jobId)),
    ).toEqual([
      `Job ${enqueued.jobId} of queue "slow" failed its last attempt (1 of 1) and moves to the dead-letter queue "slow.dead-letter": it ran longer than the 1 seconds of expireInSeconds`,
    ]);
  });

  it('logs once the attempt of a handler that ignores its signal past expireInSeconds', async () => {
    const errors: MockInstance = vi.spyOn(Logger.prototype, 'error');
    let returned: boolean = false;
    await jobs.work(
      'stuck',
      async (): Promise<void> => {
        await sleep(2_500);
        returned = true;
      },
      { pollingIntervalSeconds: 0.5 },
    );

    const enqueued: JobEnqueueResult = await transact('org-1', 'COMMIT', (tx: JobsTransaction) =>
      jobs.enqueue(tx, 'stuck', {}),
    );
    await waitFor(
      async (): Promise<boolean> => (await jobsOf('stuck.dead-letter')).length > 0,
      20_000,
    );

    expect(returned).toBe(false);
    await waitFor((): boolean => returned, 10_000);
    await sleep(200);
    expect(
      messagesOf(errors).filter((message: string): boolean => message.includes(enqueued.jobId)),
    ).toEqual([
      `Job ${enqueued.jobId} of queue "stuck" failed its last attempt (1 of 1) and moves to the dead-letter queue "stuck.dead-letter": it ran longer than the 1 seconds of expireInSeconds`,
    ]);
    expect(await jobsOf('stuck')).toMatchObject([{ id: enqueued.jobId, state: 'failed' }]);
  });

  it('runs each handler inside runInOrganization with the organization of its job', async () => {
    const seen: (readonly [string | null, OrganizationScope | undefined])[] = [];
    await jobs.work(
      'scoped',
      (job: Job): Promise<void> => {
        seen.push([job.organizationId, organizations.getStore()]);
        return Promise.resolve();
      },
      { pollingIntervalSeconds: 0.5 },
    );

    await transact('org-7', 'COMMIT', (tx: JobsTransaction) => jobs.enqueue(tx, 'scoped', {}));
    await transact(null, 'COMMIT', (tx: JobsTransaction) => jobs.enqueue(tx, 'scoped', {}));
    await waitFor((): boolean => seen.length === 2, 10_000);

    expect(seen).toContainEqual(['org-7', { organizationId: 'org-7' }]);
    expect(seen).toContainEqual([null, { organizationId: null }]);
  });

  it('refuses a queue that was not declared, a dead-letter queue and options out of bounds', async () => {
    const handler: (job: Job) => Promise<void> = (): Promise<void> => Promise.resolve();

    await expect(
      transact('org-1', 'COMMIT', (tx: JobsTransaction) => jobs.enqueue(tx, 'undeclared', {})),
    ).rejects.toThrow(/Queue "undeclared" is not declared/);
    await expect(
      transact('org-1', 'COMMIT', (tx: JobsTransaction) =>
        jobs.enqueue(tx, 'doomed.dead-letter', {}),
      ),
    ).rejects.toThrow(/is not declared/);
    await expect(
      transact('org-1', 'COMMIT', (tx: JobsTransaction) =>
        jobs.enqueue(tx, 'transactional', {}, { occurrenceKey: '' }),
      ),
    ).rejects.toThrow(/occurrenceKey must be a non-empty string/);
    await expect(jobs.work('undeclared', handler)).rejects.toThrow(/is not declared/);
    await expect(jobs.work('digests', handler, { concurrency: 0 })).rejects.toThrow(/concurrency/);
    await expect(jobs.work('digests', handler, { pollingIntervalSeconds: 0.1 })).rejects.toThrow(
      /pollingIntervalSeconds/,
    );
    await expect(jobs.schedule('undeclared', '0 8 * * *', { timeZone: 'UTC' })).rejects.toThrow(
      /is not declared/,
    );
    await expect(jobs.unschedule('not a queue')).rejects.toThrow(/Queue name must contain only/);
  });

  it('refuses a second worker on a queue', async () => {
    const handler: (job: Job) => Promise<void> = (): Promise<void> => Promise.resolve();

    await expect(jobs.work('transactional', handler)).rejects.toThrow(
      /Queue "transactional" already has a worker in this process/,
    );
    await expect(jobs.work('transactional', handler, { concurrency: 4 })).rejects.toThrow(
      /already has a worker/,
    );
  });

  it('stores a schedule with its explicit time zone, replaces it and removes it', async () => {
    const stored: () => Promise<unknown[]> = async (): Promise<unknown[]> => {
      const result: QueryResult<Record<string, unknown>> = await queryAs<Record<string, unknown>>(
        database.admin,
        'SELECT name, key, cron, timezone, data FROM pgboss.schedule ORDER BY name, key',
      );
      return result.rows;
    };

    await jobs.schedule('digests', '0 8 * * *', {
      timeZone: 'Europe/Paris',
      payload: { kind: 'daily' },
      key: 'daily',
    });
    await jobs.schedule('digests', '30 7 * * 1', { timeZone: 'America/New_York' });

    expect(await stored()).toEqual([
      {
        name: 'digests',
        key: '',
        cron: '30 7 * * 1',
        timezone: 'America/New_York',
        data: { organizationId: null, payload: null },
      },
      {
        name: 'digests',
        key: 'daily',
        cron: '0 8 * * *',
        timezone: 'Europe/Paris',
        data: { organizationId: null, payload: { kind: 'daily' } },
      },
    ]);

    await jobs.schedule('digests', '0 9 * * *', { timeZone: 'Europe/London', key: 'daily' });
    await jobs.unschedule('digests');

    expect(await stored()).toEqual([
      {
        name: 'digests',
        key: 'daily',
        cron: '0 9 * * *',
        timezone: 'Europe/London',
        data: { organizationId: null, payload: null },
      },
    ]);

    await jobs.unschedule('digests', { key: 'daily' });
    await jobs.unschedule('digests', { key: 'never-registered' });
    expect(await stored()).toEqual([]);
  });

  it('rejects a schedule without a valid time zone or with an invalid expression', async () => {
    const missing: unknown = { payload: { kind: 'daily' } };

    await expect(
      jobs.schedule('digests', '0 8 * * *', { timeZone: 'Mars/Olympus' }),
    ).rejects.toThrow(/not a known IANA time zone name/);
    await expect(jobs.schedule('digests', '0 8 * * *', { timeZone: '+02:00' })).rejects.toThrow(
      /fixed offset/,
    );
    await expect(
      jobs.schedule('digests', '0 8 * * *', missing as { timeZone: string }),
    ).rejects.toThrow(/timeZone is required/);
    await expect(jobs.schedule('digests', 'every morning', { timeZone: 'UTC' })).rejects.toThrow();

    const result: QueryResult = await queryAs(database.admin, 'SELECT name FROM pgboss.schedule');
    expect(result.rows).toEqual([]);
  });
});
