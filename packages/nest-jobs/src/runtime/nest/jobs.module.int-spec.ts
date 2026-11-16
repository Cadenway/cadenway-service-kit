import { setTimeout as sleep } from 'node:timers/promises';

import { Logger, type DynamicModule, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client, type QueryResult } from 'pg';
import { PgBoss, getRollbackPlans, type Db, type Job as BossJob } from 'pg-boss';
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

import type { Job } from '../../jobs/execution/job.js';
import type { JobEnqueueResult } from '../../jobs/enqueue/job-enqueue-options.js';
import { JobsNotProvisionedError } from '../postgres/jobs-not-provisioned.error.js';
import {
  resolveJobsModuleOptions,
  type JobsModuleOptions,
} from '../../jobs/configuration/jobs-options.js';
import { JobsModule } from './jobs.module.js';
import { JobsService } from './jobs.service.js';
import { provisionJobs } from '../../provisioning/provision-jobs.js';
import { toRuntimeBossOptions } from '../postgres/runtime-boss-options.js';
import { CONFIGURATION, ConfigurationModule } from '../../testing/configuration.module.js';
import {
  APP_ROLE,
  queryAs,
  startJobsTestServer,
  waitFor,
  type JobsTestDatabase,
  type JobsTestServer,
} from '../../testing/jobs-database.js';

/**
 * Function start
 *
 * @description
 * Boots an application made of the jobs module alone, rethrowing a start-up failure instead of
 * ending the process.
 *
 * @param {DynamicModule} module - Jobs module built by `forRoot` or `forRootAsync`.
 * @returns {Promise<INestApplicationContext>} The started application.
 */
function start(module: DynamicModule): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(module, { logger: false, abortOnError: false });
}

/**
 * Function enqueueCommitted
 *
 * @description
 * Enqueues one job in a transaction of the application role and commits it.
 *
 * @param {JobsTestDatabase} database - Database of the scenario.
 * @param {JobsService} jobs - Started runtime.
 * @param {string} queue - Declared queue.
 * @returns {Promise<JobEnqueueResult>} The outcome of the enqueue.
 */
async function enqueueCommitted(
  database: JobsTestDatabase,
  jobs: JobsService,
  queue: string,
): Promise<JobEnqueueResult> {
  const client: Client = new Client({ ...database.app });
  await client.connect();
  try {
    await client.query('BEGIN');
    const result: JobEnqueueResult = await jobs.enqueue({ client, organizationId: null }, queue, {
      step: 'test',
    });
    await client.query('COMMIT');
    return result;
  } finally {
    await client.end();
  }
}

/**
 * Function runtimeSessions
 *
 * @description
 * Counts the connections pg-boss holds on a database.
 *
 * @param {JobsTestDatabase} database - Database of the scenario.
 * @returns {Promise<number>} Number of open pg-boss sessions.
 */
async function runtimeSessions(database: JobsTestDatabase): Promise<number> {
  const result: QueryResult<{ count: number }> = await queryAs<{ count: number }>(
    database.admin,
    `SELECT count(*)::int AS count FROM pg_stat_activity
     WHERE datname = $1 AND application_name LIKE 'pgboss%'`,
    [database.name],
  );
  return result.rows[0]?.count ?? -1;
}

/** Checks that a runtime PostgreSQL query is waiting on a lock held by the test. */
async function hasBlockedRuntimeQuery(
  database: JobsTestDatabase,
  queryPattern: string,
): Promise<boolean> {
  const result: QueryResult<{ blocked: boolean }> = await queryAs<{ blocked: boolean }>(
    database.admin,
    `SELECT EXISTS (
       SELECT 1 FROM pg_stat_activity
       WHERE datname = $1 AND application_name LIKE 'pgboss%'
         AND wait_event_type = 'Lock' AND query LIKE $2
     ) AS blocked`,
    [database.name, queryPattern],
  );
  return result.rows[0]?.blocked === true;
}

/**
 * Function stateOf
 *
 * @description
 * Reads the state of one stored job.
 *
 * @param {JobsTestDatabase} database - Database of the scenario.
 * @param {string} id - Job id.
 * @returns {Promise<string | undefined>} The pg-boss state, or `undefined` when the job is gone.
 */
async function stateOf(database: JobsTestDatabase, id: string): Promise<string | undefined> {
  const result: QueryResult<{ state: string }> = await queryAs<{ state: string }>(
    database.admin,
    'SELECT state::text AS state FROM pgboss.job WHERE id = $1',
    [id],
  );
  return result.rows[0]?.state;
}

describe('JobsModule', () => {
  let server: JobsTestServer;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    server = await startJobsTestServer();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('fails start-up with a clear error when the schema was not provisioned', async () => {
    const database: JobsTestDatabase = await server.createDatabase();

    const failure: unknown = await start(
      JobsModule.forRoot({ connection: database.app, queues: [{ name: 'reminders' }] }),
    ).catch((error: unknown): unknown => error);

    expect(failure).toBeInstanceOf(JobsNotProvisionedError);
    expect((failure as Error).message).toBe(
      'The pg-boss schema "pgboss" is not installed in this database. Run provisionJobs() as the migrator role, with the same queue declarations and this role as appRole, before starting the service.',
    );
    await waitFor(async (): Promise<boolean> => (await runtimeSessions(database)) === 0, 5_000);
  });

  it('fails start-up when a declared queue was not provisioned', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    await provisionJobs({
      connection: database.migrator,
      appRole: APP_ROLE,
      queues: [{ name: 'reminders' }],
    });

    const failure: unknown = await start(
      JobsModule.forRoot({
        connection: database.app,
        queues: [{ name: 'reminders' }, { name: 'digests' }],
      }),
    ).catch((error: unknown): unknown => error);

    expect(failure).toBeInstanceOf(JobsNotProvisionedError);
    expect((failure as Error).message).toMatch(
      /^These queues do not exist in the pg-boss schema "pgboss": digests, digests\.dead-letter\. Run provisionJobs\(\)/,
    );
    await waitFor(async (): Promise<boolean> => (await runtimeSessions(database)) === 0, 5_000);
  });

  it('fails start-up when the connected role was not granted access to the schema', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    await queryAs(database.admin, 'CREATE ROLE svc_other');
    await provisionJobs({
      connection: database.migrator,
      appRole: 'svc_other',
      queues: [{ name: 'reminders' }],
    });

    const failure: unknown = await start(
      JobsModule.forRoot({ connection: database.app, queues: [{ name: 'reminders' }] }),
    ).catch((error: unknown): unknown => error);

    expect(failure).toBeInstanceOf(JobsNotProvisionedError);
    expect((failure as Error).message).toMatch(
      /^The connected role lacks a right on the pg-boss schema "pgboss" \(permission denied/,
    );
  });

  it('fails start-up on a schema of another version until it is provisioned again', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    const queues: JobsModuleOptions['queues'] = [{ name: 'reminders' }];
    await provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues });
    await queryAs(database.migrator, getRollbackPlans('pgboss'));

    const failure: unknown = await start(
      JobsModule.forRoot({ connection: database.app, queues }),
    ).catch((error: unknown): unknown => error);

    expect(failure).toBeInstanceOf(JobsNotProvisionedError);
    expect((failure as Error).message).toMatch(
      /^The pg-boss schema "pgboss" is not at the version this package expects\./,
    );

    await provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues });
    const app: INestApplicationContext = await start(
      JobsModule.forRoot({ connection: database.app, queues }),
    );
    await app.close();
  });

  it('rejects invalid options before opening a connection', async () => {
    const database: JobsTestDatabase = await server.createDatabase();

    await expect(
      start(JobsModule.forRoot({ connection: database.app, queues: [{ name: 'not a queue' }] })),
    ).rejects.toThrow(/Queue name must contain only/);
    expect(await runtimeSessions(database)).toBe(0);
  });

  it('starts through forRootAsync and warns when a stored queue differs from its declaration', async () => {
    const warnings: MockInstance = vi.spyOn(Logger.prototype, 'warn');
    const database: JobsTestDatabase = await server.createDatabase();
    await provisionJobs({
      connection: database.migrator,
      appRole: APP_ROLE,
      queues: [{ name: 'reminders' }],
    });
    const options: JobsModuleOptions = {
      connection: database.app,
      queues: [{ name: 'reminders', retryLimit: 1 }],
    };

    const app: INestApplicationContext = await start(
      JobsModule.forRootAsync({
        imports: [ConfigurationModule.with(options)],
        inject: [CONFIGURATION],
        useFactory: (configuration: JobsModuleOptions): JobsModuleOptions => configuration,
      }),
    );

    try {
      const result: JobEnqueueResult = await enqueueCommitted(
        database,
        app.get(JobsService),
        'reminders',
      );
      expect(result.duplicate).toBe(false);
      expect(warnings.mock.calls.map((call: unknown[]): string => String(call[0]))).toEqual([
        'Queue "reminders" is stored with settings that differ from its declaration (retryLimit). Run provisionJobs() to apply the declaration.',
      ]);
    } finally {
      await app.close();
    }
  });

  it('warns once when a shared dead-letter queue differs from its declared retention', async () => {
    const warnings: MockInstance = vi.spyOn(Logger.prototype, 'warn');
    const database: JobsTestDatabase = await server.createDatabase();
    const queues: JobsModuleOptions['queues'] = [
      { name: 'reminders', deadLetter: 'failed-jobs', deadLetterRetentionSeconds: 3600 },
      { name: 'digests', deadLetter: 'failed-jobs', deadLetterRetentionSeconds: 3600 },
    ];
    await provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues });

    const app: INestApplicationContext = await start(
      JobsModule.forRoot({
        connection: database.app,
        queues: queues.map((queue) => ({ ...queue, deadLetterRetentionSeconds: 7200 })),
      }),
    );
    try {
      expect(warnings.mock.calls.map((call: unknown[]): string => String(call[0]))).toEqual([
        'Queue "failed-jobs" is stored with settings that differ from its declaration (deadLetterRetentionSeconds). Run provisionJobs() to apply the declaration.',
      ]);
    } finally {
      await app.close();
    }
  });

  it('lets a running handler finish at shutdown, then closes its connections', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    const queues: JobsModuleOptions['queues'] = [{ name: 'reminders' }];
    await provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues });
    const app: INestApplicationContext = await start(
      JobsModule.forRoot({ connection: database.app, queues }),
    );
    const jobs: JobsService = app.get(JobsService);
    let started: boolean = false;
    let finished: boolean = false;
    await jobs.work(
      'reminders',
      async (): Promise<void> => {
        started = true;
        await sleep(800);
        finished = true;
      },
      { pollingIntervalSeconds: 0.5 },
    );
    const enqueued: JobEnqueueResult = await enqueueCommitted(database, jobs, 'reminders');
    await waitFor((): boolean => started, 10_000);

    await app.close();

    expect(finished).toBe(true);
    expect(await stateOf(database, enqueued.jobId)).toBe('completed');
    expect(await runtimeSessions(database)).toBe(0);
    await expect(enqueueCommitted(database, jobs, 'reminders')).rejects.toThrow(
      /JobsService is not started/,
    );
  });

  it('interrupts a handler at the shutdown deadline and still waits for its blocked PostgreSQL retry', async () => {
    const warnings: MockInstance = vi.spyOn(Logger.prototype, 'warn');
    const database: JobsTestDatabase = await server.createDatabase();
    const queues: JobsModuleOptions['queues'] = [{ name: 'reminders' }];
    await provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues });
    const app: INestApplicationContext = await start(
      JobsModule.forRoot({
        connection: database.app,
        queues,
        shutdownTimeoutMs: 1_000,
        deadLetterCheckIntervalSeconds: 0,
      }),
    );
    const jobs: JobsService = app.get(JobsService);
    const lock: Client = new Client({ ...database.admin });
    let started: boolean = false;
    let interrupted: boolean = false;
    let closed: boolean = false;
    let closing: Promise<void> | undefined;
    let release: () => void = (): void => undefined;
    const stuck: Promise<void> = new Promise<void>((resolve: () => void): void => {
      release = resolve;
    });
    await jobs.work(
      'reminders',
      (job: Job): Promise<void> => {
        started = true;
        job.signal.addEventListener(
          'abort',
          (): void => {
            interrupted = true;
          },
          { once: true },
        );
        return stuck;
      },
      { pollingIntervalSeconds: 0.5 },
    );
    const enqueued: JobEnqueueResult = await enqueueCommitted(database, jobs, 'reminders');
    await waitFor((): boolean => started, 10_000);

    try {
      await lock.connect();
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM pgboss.job WHERE id = $1 FOR UPDATE', [enqueued.jobId]);
      const closingAt: number = Date.now();
      closing = app.close().then((): void => {
        closed = true;
      });

      await waitFor((): boolean => interrupted, 3_000);
      expect(Date.now() - closingAt).toBeGreaterThanOrEqual(1_000);
      await waitFor((): Promise<boolean> => hasBlockedRuntimeQuery(database, '%'), 3_000);
      expect(await stateOf(database, enqueued.jobId)).toBe('active');
      expect(closed).toBe(false);
      expect(warnings).toHaveBeenCalledWith(
        `Job ${enqueued.jobId} of queue "reminders" failed attempt 1 of 6 and will be retried: it was still running when the shutdown timeout of 1000 ms passed`,
      );

      await lock.query('ROLLBACK');
      await closing;
      expect(await stateOf(database, enqueued.jobId)).toBe('retry');
      expect(await runtimeSessions(database)).toBe(0);
    } finally {
      await lock.end();
      release();
      await (closing ?? app.close());
    }
  });

  it('cancels a blocked dead-letter check while letting an active handler finish at shutdown', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    const queues: JobsModuleOptions['queues'] = [{ name: 'reminders' }];
    await provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues });
    const getDb = vi.spyOn(PgBoss.prototype, 'getDb');
    const app: INestApplicationContext = await start(
      JobsModule.forRoot({
        connection: database.app,
        queues,
        deadLetterCheckIntervalSeconds: 1,
        shutdownTimeoutMs: 10_000,
      }),
    );
    const lock: Client = new Client({ ...database.admin });
    let finish: () => void = (): void => undefined;
    const handler: Promise<void> = new Promise<void>((resolve: () => void): void => {
      finish = resolve;
    });
    let started: boolean = false;
    let closed: boolean = false;
    let closing: Promise<void> | undefined;
    try {
      const jobs: JobsService = app.get(JobsService);
      await jobs.work(
        'reminders',
        (): Promise<void> => {
          started = true;
          return handler;
        },
        { pollingIntervalSeconds: 0.5 },
      );
      const running: JobEnqueueResult = await enqueueCommitted(database, jobs, 'reminders');
      await waitFor((): boolean => started, 10_000);
      const queued: JobEnqueueResult = await enqueueCommitted(database, jobs, 'reminders');

      await lock.connect();
      await lock.query('BEGIN');
      const lockQuery: string = 'SELECT pg_catalog.pg_advisory_xact_lock($1::bigint)';
      const lockId: number = 37;
      await lock.query(lockQuery, [lockId]);
      const acquired = getDb.mock.results.at(-1);
      if (acquired?.type !== 'return') {
        throw new Error('Expected the runtime to have acquired a PostgreSQL handle.');
      }
      const db: Db = acquired.value;
      const executeSql: (
        text: string,
        values?: unknown[],
        options?: { readonly signal: AbortSignal },
      ) => ReturnType<Db['executeSql']> = db.executeSql.bind(db);
      // Block the probe on its own lock while leaving the workers and their bookkeeping free.
      const blockedDb: Db = {
        executeSql(
          text: string,
          values?: unknown[],
          options?: { readonly signal: AbortSignal },
        ): ReturnType<Db['executeSql']> {
          if (text.startsWith('SELECT watched.name, backlog.count')) {
            return executeSql(lockQuery, [lockId], options);
          }
          return executeSql(text, values, options);
        },
      };
      getDb.mockReturnValue(blockedDb);
      await waitFor((): Promise<boolean> => hasBlockedRuntimeQuery(database, lockQuery), 5_000);

      const stop: MockInstance = vi.spyOn(PgBoss.prototype, 'stop');
      closing = app.close().then((): void => {
        closed = true;
      });
      await vi.waitFor(
        (): void => {
          expect(stop).toHaveBeenCalledOnce();
        },
        { timeout: 3_000 },
      );
      expect(closed).toBe(false);
      finish();
      await vi.waitFor(
        (): void => {
          expect(closed).toBe(true);
        },
        { timeout: 3_000 },
      );

      await lock.query('ROLLBACK');
      expect(await stateOf(database, running.jobId)).toBe('completed');
      expect(await stateOf(database, queued.jobId)).toBe('created');
    } finally {
      await lock.end();
      finish();
      await (closing ?? app.close());
    }
  });

  it('times out a dead-letter query that is blocked during normal operation', async () => {
    const warnings: MockInstance = vi.spyOn(Logger.prototype, 'warn');
    const database: JobsTestDatabase = await server.createDatabase();
    const queues: JobsModuleOptions['queues'] = [{ name: 'reminders' }];
    await provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues });
    const app: INestApplicationContext = await start(
      JobsModule.forRoot({
        connection: database.app,
        queues,
        deadLetterCheckIntervalSeconds: 1,
        shutdownTimeoutMs: 1_000,
      }),
    );
    const lock: Client = new Client({ ...database.admin });
    try {
      await lock.connect();
      await lock.query('BEGIN');
      await lock.query('LOCK TABLE ONLY pgboss.job IN ACCESS EXCLUSIVE MODE');
      await waitFor(
        (): Promise<boolean> =>
          hasBlockedRuntimeQuery(database, 'SELECT watched.name, backlog.count%'),
        5_000,
      );
      await vi.waitFor(
        (): void => {
          expect(warnings).toHaveBeenCalledWith(
            expect.stringMatching(/^The dead-letter check failed: TimeoutError/),
          );
        },
        { timeout: 3_000 },
      );
    } finally {
      await lock.end();
      await app.close();
    }
  });

  it('starts the workers even when the initial dead-letter check fails', async () => {
    const warnings: MockInstance = vi.spyOn(Logger.prototype, 'warn');
    const database: JobsTestDatabase = await server.createDatabase();
    const queues: JobsModuleOptions['queues'] = [{ name: 'reminders' }];
    await provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues });
    interface ProbeDatabase {
      // #region Methods
      /** Executes SQL using the built-in pg-boss driver's cancellation option. */
      executeSql(
        text: string,
        values?: unknown[],
        options?: { readonly signal: AbortSignal },
      ): ReturnType<Db['executeSql']>;
      // #endregion
    }
    const driver: Db = new PgBoss(database.app).getDb();
    const prototype = Object.getPrototypeOf(driver) as ProbeDatabase;
    const executeSql = Reflect.get<ProbeDatabase, 'executeSql'>(prototype, 'executeSql');
    vi.spyOn(prototype, 'executeSql').mockImplementation(function (
      this: ProbeDatabase,
      text: string,
      values?: unknown[],
      options?: { readonly signal: AbortSignal },
    ): ReturnType<Db['executeSql']> {
      if (text.startsWith('SELECT watched.name, backlog.count')) {
        return Promise.reject(new Error('probe unavailable'));
      }
      return executeSql.call(this, text, values, options);
    });

    const app: INestApplicationContext = await start(
      JobsModule.forRoot({ connection: database.app, queues }),
    );
    try {
      const jobs: JobsService = app.get(JobsService);
      await jobs.work('reminders', (): Promise<void> => Promise.resolve(), {
        pollingIntervalSeconds: 0.5,
      });
      const enqueued: JobEnqueueResult = await enqueueCommitted(database, jobs, 'reminders');
      await waitFor(
        async (): Promise<boolean> => (await stateOf(database, enqueued.jobId)) === 'completed',
        10_000,
      );
      expect(warnings).toHaveBeenCalledWith(
        'The dead-letter check failed: Error: probe unavailable',
      );
    } finally {
      await app.close();
    }
  });

  it('reports a dead letter with an old timestamp when its transaction finally commits', async () => {
    const errors: MockInstance = vi.spyOn(Logger.prototype, 'error');
    const getDb: MockInstance = vi.spyOn(PgBoss.prototype, 'getDb');
    const database: JobsTestDatabase = await server.createDatabase();
    const queues: JobsModuleOptions['queues'] = [{ name: 'late', retryLimit: 0 }];
    await provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues });
    const options: JobsModuleOptions = {
      connection: database.app,
      queues,
      deadLetterCheckIntervalSeconds: 1,
    };
    const app: INestApplicationContext = await start(JobsModule.forRoot(options));
    const worker: PgBoss = new PgBoss(toRuntimeBossOptions(resolveJobsModuleOptions(options)));
    const client: Client = new Client({ ...database.app });
    try {
      const enqueued: JobEnqueueResult = await enqueueCommitted(
        database,
        app.get(JobsService),
        'late',
      );
      await worker.start();
      const claimed: BossJob[] = await worker.fetch('late');
      expect(claimed.map((job: BossJob): string => job.id)).toEqual([enqueued.jobId]);
      await client.connect();
      await client.query('BEGIN');
      await worker.fail(
        'late',
        enqueued.jobId,
        { message: 'failure' },
        {
          db: {
            executeSql: (text: string, values?: unknown[]): Promise<QueryResult> =>
              client.query(text, values),
          },
        },
      );
      // Model a transaction started long before the most recent monitoring snapshot.
      await client.query(
        "UPDATE pgboss.job SET created_on = now() - interval '1 day' WHERE name = $1",
        ['late.dead-letter'],
      );
      const checksBefore: number = getDb.mock.calls.length;
      await waitFor((): boolean => getDb.mock.calls.length > checksBefore + 1, 5_000);
      expect(errors).not.toHaveBeenCalled();

      await client.query('COMMIT');

      await vi.waitFor(
        (): void => {
          expect(errors).toHaveBeenCalledWith(
            '1 job(s) remain in the dead-letter queue "late.dead-letter".',
          );
        },
        { timeout: 5_000 },
      );
    } finally {
      await client.end();
      await worker.stop();
      await app.close();
    }
  });

  it('logs, from the dead-letter watch, a job dead-lettered by supervision after its worker died', async () => {
    const errors: MockInstance = vi.spyOn(Logger.prototype, 'error');
    const database: JobsTestDatabase = await server.createDatabase();
    const queues: JobsModuleOptions['queues'] = [
      { name: 'crashed', retryLimit: 0, expireInSeconds: 1 },
      { name: 'quiet' },
    ];
    await provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues });
    const options: JobsModuleOptions = {
      connection: database.app,
      queues,
      deadLetterCheckIntervalSeconds: 1,
    };
    const app: INestApplicationContext = await start(JobsModule.forRoot(options));

    try {
      const enqueued: JobEnqueueResult = await enqueueCommitted(
        database,
        app.get(JobsService),
        'crashed',
      );
      // A worker of another process claims the job, then dies without settling it.
      const dead: PgBoss = new PgBoss(toRuntimeBossOptions(resolveJobsModuleOptions(options)));
      await dead.start();
      const claimed: BossJob[] = await dead.fetch('crashed');
      await dead.stop();
      expect(claimed.map((job: BossJob): string => job.id)).toEqual([enqueued.jobId]);
      expect(await stateOf(database, enqueued.jobId)).toBe('active');

      // Once the attempt has expired, the supervision pass of any live instance fails it in SQL.
      await sleep(2_200);
      const supervisor: PgBoss = new PgBoss(
        toRuntimeBossOptions(resolveJobsModuleOptions(options)),
      );
      await supervisor.start();
      await supervisor.supervise();
      await supervisor.stop();

      expect(await stateOf(database, enqueued.jobId)).toBe('failed');
      const messages: () => string[] = (): string[] =>
        errors.mock.calls.map((call: unknown[]): string => String(call[0]));
      const alert: string = '1 job(s) remain in the dead-letter queue "crashed.dead-letter".';
      await waitFor(
        (): boolean => messages().filter((message) => message === alert).length >= 2,
        30_000,
      );
      expect(messages().every((message) => message === alert)).toBe(true);
      expect(JSON.stringify(errors.mock.calls)).not.toContain('"step"');
    } finally {
      await app.close();
    }
  });

  it('does not watch the dead-letter queues when the interval is zero', async () => {
    const errors: MockInstance = vi.spyOn(Logger.prototype, 'error');
    const database: JobsTestDatabase = await server.createDatabase();
    const queues: JobsModuleOptions['queues'] = [
      { name: 'doomed', retryLimit: 0, retryDelaySeconds: 0 },
    ];
    await provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues });
    const app: INestApplicationContext = await start(
      JobsModule.forRoot({ connection: database.app, queues, deadLetterCheckIntervalSeconds: 0 }),
    );

    try {
      const jobs: JobsService = app.get(JobsService);
      await jobs.work('doomed', (): Promise<void> => Promise.reject(new Error('refused')), {
        pollingIntervalSeconds: 0.5,
      });
      const enqueued: JobEnqueueResult = await enqueueCommitted(database, jobs, 'doomed');
      await waitFor(
        async (): Promise<boolean> => (await stateOf(database, enqueued.jobId)) === 'failed',
        15_000,
      );
      await sleep(7_000);

      expect(errors.mock.calls.map((call: unknown[]): string => String(call[0]))).toEqual([
        `Job ${enqueued.jobId} of queue "doomed" failed its last attempt (1 of 1) and moves to the dead-letter queue "doomed.dead-letter": Error: refused`,
      ]);
    } finally {
      await app.close();
    }
  });

  it('refuses to start as a role that can create objects in the schema, unless allowed', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    const queues: JobsModuleOptions['queues'] = [{ name: 'reminders' }];
    await provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues });

    const failure: unknown = await start(
      JobsModule.forRoot({ connection: database.migrator, queues }),
    ).catch((error: unknown): unknown => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(JobsNotProvisionedError);
    expect((failure as Error).message).toMatch(
      /^The runtime is connected as "svc_migrator", a role that can create objects in the pg-boss schema "pgboss"\. Connect as the application role/,
    );
    await waitFor(async (): Promise<boolean> => (await runtimeSessions(database)) === 0, 5_000);

    const app: INestApplicationContext = await start(
      JobsModule.forRoot({ connection: database.migrator, queues, allowPrivilegedRole: true }),
    );
    await app.close();
  });

  it('warns about a stored schedule whose queue left the declarations and lets it be removed', async () => {
    const warnings: MockInstance = vi.spyOn(Logger.prototype, 'warn');
    const database: JobsTestDatabase = await server.createDatabase();
    await provisionJobs({
      connection: database.migrator,
      appRole: APP_ROLE,
      queues: [{ name: 'reminders' }, { name: 'digests' }],
    });
    const first: INestApplicationContext = await start(
      JobsModule.forRoot({
        connection: database.app,
        queues: [{ name: 'reminders' }, { name: 'digests' }],
      }),
    );
    await first
      .get(JobsService)
      .schedule('digests', '0 8 * * *', { timeZone: 'Europe/Paris', key: 'daily' });
    await first.close();
    expect(warnings.mock.calls).toEqual([]);

    const second: INestApplicationContext = await start(
      JobsModule.forRoot({ connection: database.app, queues: [{ name: 'reminders' }] }),
    );

    try {
      expect(warnings.mock.calls.map((call: unknown[]): string => String(call[0]))).toEqual([
        'A schedule is stored for queue "digests" (key "daily"), which is not declared: it still creates jobs that nothing consumes. Remove it with unschedule(), or declare the queue.',
      ]);

      await second.get(JobsService).unschedule('digests', { key: 'daily' });

      const stored: QueryResult = await queryAs(database.admin, 'SELECT name FROM pgboss.schedule');
      expect(stored.rows).toEqual([]);
    } finally {
      await second.close();
    }
  });

  it('fires a stored schedule as the application role and hands the job to the worker', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    const queues: JobsModuleOptions['queues'] = [{ name: 'digests' }];
    await provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues });
    const first: INestApplicationContext = await start(
      JobsModule.forRoot({ connection: database.app, queues }),
    );
    await first
      .get(JobsService)
      .schedule('digests', '* * * * *', { timeZone: 'UTC', payload: { kind: 'tick' } });
    await first.close();
    // pg-boss evaluates schedules at start-up and then every 30 seconds, one instance at a time.
    // Clearing the claim of the first instance makes the next start-up run the pass at once.
    await queryAs(database.admin, 'UPDATE pgboss.version SET cron_on = NULL');
    const received: Job[] = [];

    const second: INestApplicationContext = await start(
      JobsModule.forRoot({ connection: database.app, queues }),
    );
    try {
      await second.get(JobsService).work(
        'digests',
        (job: Job): Promise<void> => {
          received.push(job);
          return Promise.resolve();
        },
        { pollingIntervalSeconds: 0.5 },
      );
      await waitFor((): boolean => received.length > 0, 45_000);

      expect(received[0]).toMatchObject({
        queue: 'digests',
        payload: { kind: 'tick' },
        organizationId: null,
        attempt: 1,
      });
    } finally {
      await second.close();
    }
  });
});
