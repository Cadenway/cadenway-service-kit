import { setTimeout as sleep } from 'node:timers/promises';

import { Logger, type DynamicModule, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client, type QueryResult } from 'pg';
import { PgBoss, getRollbackPlans, type Job as BossJob } from 'pg-boss';
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

import type { Job, JobEnqueueResult } from './job.js';
import { JobsNotProvisionedError } from './jobs-not-provisioned.error.js';
import { resolveJobsModuleOptions, type JobsModuleOptions } from './jobs-options.js';
import { JobsModule } from './jobs.module.js';
import { JobsService } from './jobs.service.js';
import { provisionJobs } from './provision-jobs.js';
import { toRuntimeBossOptions } from './runtime-boss-options.js';
import { CONFIGURATION, ConfigurationModule } from './testing/configuration.module.js';
import {
  APP_ROLE,
  queryAs,
  startJobsTestServer,
  waitFor,
  type JobsTestDatabase,
  type JobsTestServer,
} from './testing/jobs-database.js';

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

  it('fails and logs the attempt of a handler still running after the shutdown timeout, so it is retried', async () => {
    const warnings: MockInstance = vi.spyOn(Logger.prototype, 'warn');
    const database: JobsTestDatabase = await server.createDatabase();
    const queues: JobsModuleOptions['queues'] = [{ name: 'reminders' }];
    await provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues });
    const app: INestApplicationContext = await start(
      JobsModule.forRoot({ connection: database.app, queues, shutdownTimeoutMs: 1_000 }),
    );
    const jobs: JobsService = app.get(JobsService);
    let started: boolean = false;
    let release: () => void = (): void => undefined;
    const stuck: Promise<void> = new Promise<void>((resolve: () => void): void => {
      release = resolve;
    });
    await jobs.work(
      'reminders',
      (): Promise<void> => {
        started = true;
        return stuck;
      },
      { pollingIntervalSeconds: 0.5 },
    );
    const enqueued: JobEnqueueResult = await enqueueCommitted(database, jobs, 'reminders');
    await waitFor((): boolean => started, 10_000);

    try {
      const closingAt: number = Date.now();
      await app.close();

      expect(Date.now() - closingAt).toBeGreaterThanOrEqual(1_000);
      expect(await stateOf(database, enqueued.jobId)).toBe('retry');
      expect(await runtimeSessions(database)).toBe(0);
      expect(warnings.mock.calls.map((call: unknown[]): string => String(call[0]))).toEqual([
        `Job ${enqueued.jobId} of queue "reminders" failed attempt 1 of 6 and will be retried: it was still running when the shutdown timeout of 1000 ms passed`,
      ]);
    } finally {
      release();
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
      await waitFor(
        (): boolean =>
          messages().includes(
            '1 job(s) reached the dead-letter queue "crashed.dead-letter" since the previous check.',
          ),
        30_000,
      );
      await sleep(2_500);
      expect(messages()).toEqual([
        '1 job(s) reached the dead-letter queue "crashed.dead-letter" since the previous check.',
      ]);
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
