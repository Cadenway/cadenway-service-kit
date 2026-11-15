import { Logger } from '@nestjs/common';
import { getRollbackPlans } from 'pg-boss';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { provisionJobs } from './provision-jobs.js';
import {
  APP_ROLE,
  MIGRATOR_ROLE,
  PG_BOSS_SCHEMA_LOCK,
  PROVISIONING_LOCK,
  holdAdvisoryLock,
  queryAs,
  startJobsTestServer,
  waitFor,
  waitForAdvisoryWaiter,
  type HeldLock,
  type JobsTestDatabase,
  type JobsTestServer,
} from './testing/jobs-database.js';

/**
 * Interface QueueRow
 *
 * @description
 * The columns of a stored queue these specs compare with its declaration.
 */
interface QueueRow {
  // #region Properties
  /**
   * Property name
   *
   * @description
   * Queue name.
   *
   * @type {string}
   * @readonly
   */
  readonly name: string;

  /**
   * Property policy
   *
   * @description
   * pg-boss queue policy.
   *
   * @type {string}
   * @readonly
   */
  readonly policy: string;

  /**
   * Property retry_limit
   *
   * @description
   * Retries after the first attempt.
   *
   * @type {number}
   * @readonly
   */
  readonly retry_limit: number;

  /**
   * Property retry_delay
   *
   * @description
   * Base retry delay in seconds.
   *
   * @type {number}
   * @readonly
   */
  readonly retry_delay: number;

  /**
   * Property retry_backoff
   *
   * @description
   * Whether the delay doubles at each retry.
   *
   * @type {boolean}
   * @readonly
   */
  readonly retry_backoff: boolean;

  /**
   * Property retry_delay_max
   *
   * @description
   * Backoff ceiling in seconds, or `null`.
   *
   * @type {number | null}
   * @readonly
   */
  readonly retry_delay_max: number | null;

  /**
   * Property dead_letter
   *
   * @description
   * Dead-letter queue, or `null` for a dead-letter queue itself.
   *
   * @type {string | null}
   * @readonly
   */
  readonly dead_letter: string | null;

  /**
   * Property retention_seconds
   *
   * @description
   * Time a job may wait without being started, in seconds.
   *
   * @type {number}
   * @readonly
   */
  readonly retention_seconds: number;
  // #endregion
}

/**
 * Constant QUEUE_COLUMNS
 *
 * @description
 * Statement that reads the stored queues in name order, pg-boss internal queues left out.
 *
 * @type {string}
 */
const QUEUE_COLUMNS: string = `
  SELECT name, policy, retry_limit, retry_delay, retry_backoff, retry_delay_max, dead_letter,
         retention_seconds
  FROM pgboss.queue
  WHERE name NOT LIKE '\\_\\_pgboss\\_\\_%'
  ORDER BY name`;

/**
 * Function schemaVersion
 *
 * @description
 * Reads the installed pg-boss schema version.
 *
 * @param {JobsTestDatabase} database - Database to read.
 * @returns {Promise<number>} The version stored by pg-boss.
 */
async function schemaVersion(database: JobsTestDatabase): Promise<number> {
  const result: QueryResult<{ version: number }> = await queryAs<{ version: number }>(
    database.admin,
    'SELECT version FROM pgboss.version',
  );
  return result.rows[0]?.version ?? -1;
}

/**
 * Function holds
 *
 * @description
 * Evaluates one boolean SQL expression as the superuser, for privilege checks.
 *
 * @param {JobsTestDatabase} database - Database to query.
 * @param {string} expression - SQL expression that yields a boolean.
 * @returns {Promise<boolean>} The value of the expression.
 */
async function holds(database: JobsTestDatabase, expression: string): Promise<boolean> {
  const result: QueryResult<{ held: boolean }> = await queryAs<{ held: boolean }>(
    database.admin,
    `SELECT ${expression} AS held`,
  );
  return result.rows[0]?.held ?? false;
}

/**
 * Constant PLANT_INDEX_BUILD
 *
 * @description
 * What a compromised service would insert into `bam`: a statement pg-boss would execute as the
 * migrator role. Executed, it leaves a table behind in `public`, which the database owner, the
 * migrator role, can create.
 *
 * @type {string}
 */
const PLANT_INDEX_BUILD: string = `INSERT INTO pgboss.bam (name, version, table_name, command)
  VALUES ('planted', 1, 'job_common', 'CREATE TABLE public.planted_by_app (id integer)')`;

/**
 * Constant PLANTED_ROW_NEVER_RAN
 *
 * @description
 * Holds when the statement planted in `bam` was never executed.
 *
 * @type {string}
 */
const PLANTED_ROW_NEVER_RAN: string = "to_regclass('public.planted_by_app') IS NULL";

/**
 * Function settle
 *
 * @description
 * Lets a test await a run it started earlier without an unhandled rejection in between.
 *
 * @param {Promise<void>} run - The provisioning run.
 * @returns {Promise<unknown>} `undefined` when the run succeeded, its error otherwise.
 */
function settle(run: Promise<void>): Promise<unknown> {
  return run.then(
    (): undefined => undefined,
    (error: unknown): unknown => error,
  );
}

describe('provisionJobs', () => {
  let server: JobsTestServer;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    server = await startJobsTestServer();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('installs the schema, the queues and their dead-letter queues as the migrator role', async () => {
    const database: JobsTestDatabase = await server.createDatabase();

    await provisionJobs({
      connection: database.migrator,
      appRole: APP_ROLE,
      queues: [
        { name: 'reminders', retryLimit: 3, retryDelaySeconds: 2 },
        {
          name: 'purge',
          retryBackoff: false,
          deadLetter: 'failed',
          deadLetterRetentionSeconds: 60,
        },
      ],
    });

    const queues: QueryResult<QueueRow> = await queryAs<QueueRow>(database.admin, QUEUE_COLUMNS);
    expect(queues.rows).toEqual([
      {
        name: 'failed',
        policy: 'standard',
        retry_limit: 0,
        retry_delay: 0,
        retry_backoff: false,
        retry_delay_max: null,
        dead_letter: null,
        retention_seconds: 60,
      },
      {
        name: 'purge',
        policy: 'standard',
        retry_limit: 5,
        retry_delay: 30,
        retry_backoff: false,
        retry_delay_max: null,
        dead_letter: 'failed',
        retention_seconds: 1_209_600,
      },
      {
        name: 'reminders',
        policy: 'standard',
        retry_limit: 3,
        retry_delay: 2,
        retry_backoff: true,
        retry_delay_max: 3_600,
        dead_letter: 'reminders.dead-letter',
        retention_seconds: 1_209_600,
      },
      {
        name: 'reminders.dead-letter',
        policy: 'standard',
        retry_limit: 0,
        retry_delay: 0,
        retry_backoff: false,
        retry_delay_max: null,
        dead_letter: null,
        retention_seconds: 1_209_600,
      },
    ]);
    const owner: QueryResult<{ owner: string }> = await queryAs<{ owner: string }>(
      database.admin,
      "SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = 'pgboss'",
    );
    expect(owner.rows).toEqual([{ owner: MIGRATOR_ROLE }]);
    expect(await schemaVersion(database)).toBeGreaterThan(0);
  });

  it('grants the application role data access to the runtime tables and no DDL right', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    await provisionJobs({
      connection: database.migrator,
      appRole: APP_ROLE,
      queues: [{ name: 'reminders' }],
    });

    const missing: QueryResult<{ relname: string; privilege: string }> = await queryAs<{
      relname: string;
      privilege: string;
    }>(
      database.admin,
      `SELECT c.relname::text AS relname, p.privilege
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p(privilege)
       WHERE n.nspname = 'pgboss'
         AND c.relkind IN ('r', 'p')
         AND c.relname NOT IN ('bam', 'version')
         AND NOT has_table_privilege($1, c.oid, p.privilege)`,
      [APP_ROLE],
    );
    expect(missing.rows).toEqual([]);
    expect(await holds(database, `has_schema_privilege('${APP_ROLE}', 'pgboss', 'USAGE')`)).toBe(
      true,
    );
    expect(await holds(database, `has_schema_privilege('${APP_ROLE}', 'pgboss', 'CREATE')`)).toBe(
      false,
    );
    expect(
      await holds(database, `has_database_privilege('${APP_ROLE}', current_database(), 'CREATE')`),
    ).toBe(false);
    expect(
      await holds(database, `has_table_privilege('${APP_ROLE}', 'pgboss.job', 'TRUNCATE')`),
    ).toBe(false);

    await queryAs(database.app, 'SELECT count(*) FROM pgboss.queue');
    for (const statement of [
      'CREATE TABLE pgboss.forbidden (id integer)',
      'CREATE SCHEMA forbidden',
      'ALTER TABLE pgboss.job ADD COLUMN forbidden integer',
      'CREATE INDEX forbidden ON pgboss.job (created_on)',
      'DROP TABLE pgboss.warning',
      'TRUNCATE pgboss.warning',
    ]) {
      await expect(queryAs(database.app, statement), statement).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('gives the application role no right on the statements the migrator role runs, despite the platform default privileges', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    await queryAs(database.migrator, 'CREATE TABLE public.ops_default_probe (id integer)');
    expect(
      await holds(
        database,
        `has_table_privilege('${APP_ROLE}', 'public.ops_default_probe', 'INSERT')`,
      ),
      'the ops default privileges open a new table of the migrator role to the application role',
    ).toBe(true);

    await provisionJobs({
      connection: database.migrator,
      appRole: APP_ROLE,
      queues: [{ name: 'reminders' }],
    });

    for (const privilege of [
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER',
    ]) {
      expect(
        await holds(database, `has_table_privilege('${APP_ROLE}', 'pgboss.bam', '${privilege}')`),
        privilege,
      ).toBe(false);
    }
    for (const statement of [
      `INSERT INTO pgboss.bam (name, version, table_name, command)
       VALUES ('planted', 1, 'job_common', 'ALTER ROLE ${APP_ROLE} SUPERUSER')`,
      `SELECT pgboss.job_table_run_async('planted', 1, 'ALTER ROLE ${APP_ROLE} SUPERUSER', 'job_common')`,
      'SELECT count(*) FROM pgboss.bam',
      "UPDATE pgboss.bam SET status = 'pending'",
      'DELETE FROM pgboss.bam',
    ]) {
      await expect(queryAs(database.app, statement), statement).rejects.toMatchObject({
        code: '42501',
      });
    }
    const planted: QueryResult = await queryAs(database.admin, 'SELECT name FROM pgboss.bam');
    expect(planted.rows).toEqual([]);
  });

  it('lets the application role stamp the interval claims of the version table and nothing else', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    await provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues: [] });
    const version: number = await schemaVersion(database);

    expect(
      await holds(database, `has_table_privilege('${APP_ROLE}', 'pgboss.version', 'SELECT')`),
    ).toBe(true);
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
      expect(
        await holds(
          database,
          `has_table_privilege('${APP_ROLE}', 'pgboss.version', '${privilege}')`,
        ),
        privilege,
      ).toBe(false);
    }
    for (const column of ['version', 'bam_on']) {
      expect(
        await holds(
          database,
          `has_column_privilege('${APP_ROLE}', 'pgboss.version', '${column}', 'UPDATE')`,
        ),
        column,
      ).toBe(false);
    }
    for (const column of ['cron_on', 'flow_on', 'reindex_on', 'monitor_backoff_on']) {
      expect(
        await holds(
          database,
          `has_column_privilege('${APP_ROLE}', 'pgboss.version', '${column}', 'UPDATE')`,
        ),
        column,
      ).toBe(true);
    }

    await queryAs(database.app, 'UPDATE pgboss.version SET cron_on = now(), flow_on = now()');
    for (const statement of [
      'UPDATE pgboss.version SET version = 1',
      'UPDATE pgboss.version SET bam_on = now() + interval $$1 year$$',
      'INSERT INTO pgboss.version (version) VALUES (1)',
      'DELETE FROM pgboss.version',
    ]) {
      await expect(queryAs(database.app, statement), statement).rejects.toMatchObject({
        code: '42501',
      });
    }
    expect(await schemaVersion(database)).toBe(version);
  });

  it('keeps the schema closed to the application role while pg-boss installs, despite the platform default privileges', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    let install: HeldLock | null = await holdAdvisoryLock(database.admin, PG_BOSS_SCHEMA_LOCK);
    let checks: HeldLock | null = null;
    const run: Promise<unknown> = settle(
      provisionJobs({
        connection: database.migrator,
        appRole: APP_ROLE,
        queues: [{ name: 'reminders' }],
      }),
    );

    try {
      // Stopped right before pg-boss installs: the provisioning created the schema itself.
      await waitForAdvisoryWaiter(database, MIGRATOR_ROLE);
      expect(await holds(database, "to_regnamespace('pgboss') IS NOT NULL")).toBe(true);
      expect(await holds(database, `has_schema_privilege('${APP_ROLE}', 'pgboss', 'USAGE')`)).toBe(
        false,
      );
      await expect(
        queryAs(database.app, 'CREATE TABLE pgboss.planted (id integer)'),
      ).rejects.toMatchObject({ code: '42501' });

      // Then right after pg-boss installed, before the provisioning checks bam again.
      checks = await holdAdvisoryLock(database.admin, PROVISIONING_LOCK);
      await install.release();
      install = null;
      await waitFor(
        async (): Promise<boolean> => holds(database, "to_regclass('pgboss.bam') IS NOT NULL"),
        20_000,
      );
      await waitForAdvisoryWaiter(database, MIGRATOR_ROLE);
      expect(
        await holds(database, `has_table_privilege('${APP_ROLE}', 'pgboss.bam', 'INSERT')`),
        'the ops default privileges reached bam',
      ).toBe(true);
      expect(await holds(database, `has_schema_privilege('${APP_ROLE}', 'pgboss', 'USAGE')`)).toBe(
        false,
      );
      for (const statement of [
        PLANT_INDEX_BUILD,
        'SELECT count(*) FROM pgboss.bam',
        'SELECT version FROM pgboss.version',
        'UPDATE pgboss.version SET bam_on = NULL, version = 1',
        `SELECT pgboss.job_table_run_async('planted', 1, 'ALTER ROLE ${APP_ROLE} SUPERUSER', 'job_common')`,
      ]) {
        await expect(queryAs(database.app, statement), statement).rejects.toMatchObject({
          code: '42501',
        });
      }
    } finally {
      await checks?.release();
      await install?.release();
    }

    expect(await run).toBeUndefined();
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(
        await holds(database, `has_table_privilege('${APP_ROLE}', 'pgboss.bam', '${privilege}')`),
        privilege,
      ).toBe(false);
    }
    expect(await holds(database, `has_schema_privilege('${APP_ROLE}', 'pgboss', 'USAGE')`)).toBe(
      true,
    );
    expect(await holds(database, PLANTED_ROW_NEVER_RAN)).toBe(true);
    const planted: QueryResult = await queryAs(database.admin, 'SELECT name FROM pgboss.bam');
    expect(planted.rows).toEqual([]);
  });

  it('fails closed, before any index build runs, when a role that can use the schema can write bam', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    const options: Parameters<typeof provisionJobs>[0] = {
      connection: database.migrator,
      appRole: APP_ROLE,
      queues: [{ name: 'reminders' }],
    };
    await provisionJobs(options);
    await queryAs(database.admin, `GRANT INSERT ON pgboss.bam TO ${APP_ROLE}`);
    await queryAs(database.app, PLANT_INDEX_BUILD);

    for (let run: number = 0; run < 2; run += 1) {
      await expect(provisionJobs(options)).rejects.toThrow(
        /Roles that can use schema "pgboss" hold privileges on the tables the migrator role acts on \(svc_app on bam\).*Nothing was executed and nothing was revoked/u,
      );
    }

    expect(await holds(database, PLANTED_ROW_NEVER_RAN)).toBe(true);
    const planted: QueryResult<{ status: string }> = await queryAs<{ status: string }>(
      database.admin,
      "SELECT status FROM pgboss.bam WHERE name = 'planted'",
    );
    expect(planted.rows).toEqual([{ status: 'pending' }]);
  });

  it('holds the index builds of a migration until bam was checked again, and fails closed if it became writable', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    const options: Parameters<typeof provisionJobs>[0] = {
      connection: database.migrator,
      appRole: APP_ROLE,
      queues: [{ name: 'reminders' }],
    };
    await provisionJobs(options);
    await queryAs(database.migrator, getRollbackPlans('pgboss'));
    const migration: HeldLock = await holdAdvisoryLock(database.admin, PG_BOSS_SCHEMA_LOCK);
    const run: Promise<unknown> = settle(provisionJobs(options));

    try {
      // Stopped right before pg-boss migrates, with its index builds held back.
      await waitForAdvisoryWaiter(database, MIGRATOR_ROLE);
      expect(await holds(database, '(SELECT bam_on > now() FROM pgboss.version)')).toBe(true);
      // A migration that creates bam opens it to the application role through the default
      // privileges; this grant stands for it.
      await queryAs(database.admin, `GRANT INSERT ON pgboss.bam TO ${APP_ROLE}`);
      await queryAs(database.app, PLANT_INDEX_BUILD);
    } finally {
      await migration.release();
    }

    const failure: unknown = await run;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /hold privileges on the tables the migrator role acts on \(svc_app on bam\).*the index builds stay held/u,
    );
    expect(await holds(database, PLANTED_ROW_NEVER_RAN)).toBe(true);
    const builds: QueryResult<{ status: string; count: number }> = await queryAs<{
      status: string;
      count: number;
    }>(database.admin, 'SELECT status, count(*)::int AS count FROM pgboss.bam GROUP BY status');
    expect(builds.rows.map((row: { status: string }): string => row.status)).toEqual(['pending']);
    expect(builds.rows[0]?.count).toBeGreaterThan(1);
    expect(await holds(database, '(SELECT bam_on > now() FROM pgboss.version)')).toBe(true);

    // The operator revokes the privilege and removes the planted row, then provisions again.
    await queryAs(database.admin, `REVOKE INSERT ON pgboss.bam FROM ${APP_ROLE}`);
    await queryAs(database.admin, "DELETE FROM pgboss.bam WHERE name = 'planted'");
    await provisionJobs(options);

    expect(await holds(database, PLANTED_ROW_NEVER_RAN)).toBe(true);
    const unfinished: QueryResult = await queryAs(
      database.admin,
      "SELECT name FROM pgboss.bam WHERE status <> 'completed'",
    );
    expect(unfinished.rows).toEqual([]);
    expect(await holds(database, '(SELECT bam_on <= now() FROM pgboss.version)')).toBe(true);
  });

  it('revokes, and goes on, the privileges on bam of a role that cannot use the schema', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    const options: Parameters<typeof provisionJobs>[0] = {
      connection: database.migrator,
      appRole: APP_ROLE,
      queues: [{ name: 'reminders' }],
    };
    await provisionJobs(options);
    // As a first install that stopped before its grants leaves it: closed schema, default grants.
    await queryAs(database.admin, `REVOKE USAGE ON SCHEMA pgboss FROM ${APP_ROLE}`);
    await queryAs(database.admin, `GRANT ALL ON pgboss.bam TO ${APP_ROLE}`);
    await queryAs(database.admin, `GRANT ALL ON pgboss.version TO ${APP_ROLE}`);

    await provisionJobs(options);

    expect(
      await holds(
        database,
        `has_table_privilege('${APP_ROLE}', 'pgboss.bam', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')`,
      ),
    ).toBe(false);
    expect(
      await holds(
        database,
        `has_table_privilege('${APP_ROLE}', 'pgboss.version', 'INSERT, UPDATE, DELETE, TRUNCATE')`,
      ),
    ).toBe(false);
    expect(await holds(database, `has_schema_privilege('${APP_ROLE}', 'pgboss', 'USAGE')`)).toBe(
      true,
    );
  });

  it('refuses a stored schema older than the background index builds of pg-boss', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    const options: Parameters<typeof provisionJobs>[0] = {
      connection: database.migrator,
      appRole: APP_ROLE,
      queues: [{ name: 'reminders' }],
    };
    await provisionJobs(options);
    await queryAs(database.migrator, 'ALTER TABLE pgboss.version DROP COLUMN bam_on');

    await expect(provisionJobs(options)).rejects.toThrow(
      /older than the background index builds of pg-boss 12\.6 \(schema version 27\).*nothing was changed/u,
    );
  });

  it('manages no access when the application role is the role it connects as', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    const options: Parameters<typeof provisionJobs>[0] = {
      connection: database.migrator,
      appRole: MIGRATOR_ROLE,
      queues: [{ name: 'reminders' }],
    };

    await provisionJobs(options);
    await provisionJobs(options);

    expect(await schemaVersion(database)).toBeGreaterThan(0);
    await queryAs(database.migrator, 'SELECT count(*) FROM pgboss.bam');
    await queryAs(database.migrator, 'UPDATE pgboss.version SET cron_on = now()');
  });

  it('sets no default privilege: without platform defaults, a later table waits for the next run', async () => {
    const database: JobsTestDatabase = await server.createDatabase(true, false);
    await provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues: [] });

    await queryAs(database.migrator, 'CREATE TABLE pgboss.added_later (id integer)');

    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(
        await holds(
          database,
          `has_table_privilege('${APP_ROLE}', 'pgboss.added_later', '${privilege}')`,
        ),
        privilege,
      ).toBe(false);
    }
    await expect(queryAs(database.app, 'SELECT id FROM pgboss.added_later')).rejects.toMatchObject({
      code: '42501',
    });

    await provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues: [] });

    await queryAs(database.app, 'SELECT id FROM pgboss.added_later');
  });

  it('refuses to run when the application role planted a partitioned queue row', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    const options: Parameters<typeof provisionJobs>[0] = {
      connection: database.migrator,
      appRole: APP_ROLE,
      queues: [{ name: 'reminders' }],
    };
    await provisionJobs(options);
    await queryAs(
      database.app,
      `INSERT INTO pgboss.queue
         (name, policy, retry_limit, retry_delay, retry_backoff, expire_seconds, retention_seconds,
          deletion_seconds, partition, table_name)
       VALUES ('planted', 'standard', 0, 0, false, 900, 900, 900, true,
               'x ON pgboss.job (id); ALTER ROLE ${APP_ROLE} SUPERUSER; --')`,
    );

    await expect(provisionJobs(options)).rejects.toThrow(
      /holds rows this package does not create \(partitioned, or on another job table\): "planted"/,
    );
  });

  it('closes the queue table to the application role before a migration and refuses planted rows', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    const options: Parameters<typeof provisionJobs>[0] = {
      connection: database.migrator,
      appRole: APP_ROLE,
      queues: [{ name: 'reminders' }],
    };
    await provisionJobs(options);
    const current: number = await schemaVersion(database);
    await queryAs(database.migrator, getRollbackPlans('pgboss'));
    await queryAs(
      database.app,
      "UPDATE pgboss.queue SET table_name = 'elsewhere' WHERE name = 'reminders'",
    );

    await expect(provisionJobs(options)).rejects.toThrow(/holds rows this package does not create/);

    expect(await schemaVersion(database)).toBe(current - 1);
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
      expect(
        await holds(database, `has_table_privilege('${APP_ROLE}', 'pgboss.queue', '${privilege}')`),
        privilege,
      ).toBe(false);
    }
    const superuser: QueryResult<{ rolsuper: boolean }> = await queryAs<{ rolsuper: boolean }>(
      database.admin,
      'SELECT rolsuper FROM pg_roles WHERE rolname = $1',
      [APP_ROLE],
    );
    expect(superuser.rows).toEqual([{ rolsuper: false }]);

    await queryAs(
      database.admin,
      "UPDATE pgboss.queue SET table_name = 'job_common' WHERE name = 'reminders'",
    );
    await provisionJobs(options);

    expect(await schemaVersion(database)).toBe(current);
    expect(
      await holds(database, `has_table_privilege('${APP_ROLE}', 'pgboss.queue', 'INSERT')`),
    ).toBe(true);
  });

  it('refuses a stored schema newer than the pg-boss version of this package', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    const options: Parameters<typeof provisionJobs>[0] = {
      connection: database.migrator,
      appRole: APP_ROLE,
      queues: [{ name: 'reminders' }],
    };
    await provisionJobs(options);
    const current: number = await schemaVersion(database);
    await queryAs(database.admin, 'UPDATE pgboss.version SET version = version + 1');

    await expect(provisionJobs({ ...options, queues: [{ name: 'digests' }] })).rejects.toThrow(
      new RegExp(
        `is at pg-boss version ${String(current + 1)}, newer than the version ${String(current)} of this package`,
        'u',
      ),
    );

    const queues: QueryResult<QueueRow> = await queryAs<QueueRow>(database.admin, QUEUE_COLUMNS);
    expect(queues.rows.map((queue: QueueRow): string => queue.name)).toEqual([
      'reminders',
      'reminders.dead-letter',
    ]);
  });

  it('lets two provisioning runs started together both succeed', async () => {
    const fresh: JobsTestDatabase = await server.createDatabase();
    const options: Parameters<typeof provisionJobs>[0] = {
      connection: fresh.migrator,
      appRole: APP_ROLE,
      queues: [{ name: 'reminders' }, { name: 'digests' }],
    };

    await Promise.all([provisionJobs(options), provisionJobs(options)]);
    await Promise.all([provisionJobs(options), provisionJobs(options), provisionJobs(options)]);

    const queues: QueryResult<QueueRow> = await queryAs<QueueRow>(fresh.admin, QUEUE_COLUMNS);
    expect(queues.rows.map((queue: QueueRow): string => queue.name)).toEqual([
      'digests',
      'digests.dead-letter',
      'reminders',
      'reminders.dead-letter',
    ]);
    await queryAs(fresh.app, 'SELECT count(*) FROM pgboss.job');
  });

  it('is idempotent and applies a changed declaration to an existing queue', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    await provisionJobs({
      connection: database.migrator,
      appRole: APP_ROLE,
      queues: [{ name: 'reminders' }, { name: 'digests' }],
    });

    await provisionJobs({
      connection: database.migrator,
      appRole: APP_ROLE,
      queues: [{ name: 'reminders', retryLimit: 1, retryBackoff: false, deadLetter: 'failed' }],
    });

    const queues: QueryResult<QueueRow> = await queryAs<QueueRow>(database.admin, QUEUE_COLUMNS);
    expect(queues.rows.map((queue: QueueRow): string => queue.name)).toEqual([
      'digests',
      'digests.dead-letter',
      'failed',
      'reminders',
      'reminders.dead-letter',
    ]);
    expect(
      queues.rows.find((queue: QueueRow): boolean => queue.name === 'reminders'),
    ).toMatchObject({
      retry_limit: 1,
      retry_backoff: false,
      retry_delay_max: null,
      dead_letter: 'failed',
    });
  });

  it('uses an existing schema when the migrator role cannot create one, and closes it until its grants', async () => {
    const database: JobsTestDatabase = await server.createDatabase(false);
    await queryAs(database.admin, `CREATE SCHEMA pgboss AUTHORIZATION ${MIGRATOR_ROLE}`);
    await queryAs(database.admin, `GRANT USAGE ON SCHEMA pgboss TO PUBLIC`);
    expect(
      await holds(database, `has_schema_privilege('${APP_ROLE}', 'pgboss', 'USAGE')`),
      'the ops default privileges follow the owner of the schema',
    ).toBe(true);

    await provisionJobs({
      connection: database.migrator,
      appRole: APP_ROLE,
      queues: [{ name: 'reminders' }],
    });

    expect(await schemaVersion(database)).toBeGreaterThan(0);
    expect(
      await holds(database, `has_table_privilege('${APP_ROLE}', 'pgboss.bam', 'SELECT, INSERT')`),
    ).toBe(false);
    expect(
      await holds(
        database,
        "EXISTS (SELECT 1 FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname = 'pgboss' AND a.grantee = 0)",
      ),
      'the schema was closed to PUBLIC too',
    ).toBe(false);
  });

  it('refuses to install when the application role keeps a usage of the schema the migrator cannot revoke', async () => {
    const database: JobsTestDatabase = await server.createDatabase(false);
    await queryAs(database.admin, 'CREATE SCHEMA pgboss');
    await queryAs(database.admin, `GRANT ALL ON SCHEMA pgboss TO ${MIGRATOR_ROLE}`);
    await queryAs(database.admin, `GRANT USAGE ON SCHEMA pgboss TO ${APP_ROLE}`);

    await expect(
      provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues: [] }),
    ).rejects.toThrow(
      /Role "svc_app" can still use schema "pgboss" after every privilege on it was revoked.*Nothing was installed/u,
    );
    expect(await holds(database, "to_regclass('pgboss.version') IS NULL")).toBe(true);
  });

  it('fails when the migrator role can neither create nor use the schema', async () => {
    const database: JobsTestDatabase = await server.createDatabase(false);

    await expect(
      provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues: [] }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a role that does not exist before installing anything', async () => {
    const database: JobsTestDatabase = await server.createDatabase();

    await expect(
      provisionJobs({ connection: database.migrator, appRole: 'missing_app', queues: [] }),
    ).rejects.toThrow(/Role "missing_app" does not exist/);

    const schemas: QueryResult = await queryAs(
      database.admin,
      "SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss'",
    );
    expect(schemas.rows).toEqual([]);
  });

  it('refuses names that cannot be written safely into a statement', async () => {
    const database: JobsTestDatabase = await server.createDatabase();

    await expect(
      provisionJobs({
        connection: database.migrator,
        appRole: `${APP_ROLE}"; DROP SCHEMA pgboss CASCADE; --`,
        queues: [],
      }),
    ).rejects.toThrow(/appRole must be/);
    await expect(
      provisionJobs({
        connection: database.migrator,
        appRole: APP_ROLE,
        schema: 'Jobs',
        queues: [],
      }),
    ).rejects.toThrow(/schema must be/);
    await expect(provisionJobs({ connection: {}, appRole: APP_ROLE, queues: [] })).rejects.toThrow(
      /connection needs a connectionString, or a host with a user and a database/,
    );
  });

  it('refuses the public schema, whose table grants would reach business tables', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    await queryAs(database.admin, 'CREATE TABLE public.invoices (id integer)');

    await expect(
      provisionJobs({
        connection: database.migrator,
        appRole: APP_ROLE,
        schema: 'public',
        queues: [],
      }),
    ).rejects.toThrow(/schema must be a schema of its own: "public" is reserved/);

    expect(
      await holds(database, `has_table_privilege('${APP_ROLE}', 'public.invoices', 'SELECT')`),
    ).toBe(false);
    const installed: QueryResult = await queryAs(
      database.admin,
      "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'job'",
    );
    expect(installed.rows).toEqual([]);
  });

  it('migrates an older schema and finishes the index builds of the migration', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    const options: Parameters<typeof provisionJobs>[0] = {
      connection: database.migrator,
      appRole: APP_ROLE,
      queues: [{ name: 'reminders' }],
    };
    await provisionJobs(options);
    const current: number = await schemaVersion(database);
    await queryAs(database.migrator, getRollbackPlans('pgboss'));
    expect(await schemaVersion(database)).toBe(current - 1);

    await provisionJobs(options);

    expect(await schemaVersion(database)).toBe(current);
    const unfinished: QueryResult<{ name: string }> = await queryAs<{ name: string }>(
      database.admin,
      "SELECT name FROM pgboss.bam WHERE status <> 'completed'",
    );
    expect(unfinished.rows).toEqual([]);
    const built: QueryResult<{ name: string }> = await queryAs<{ name: string }>(
      database.admin,
      "SELECT name FROM pgboss.bam WHERE status = 'completed'",
    );
    expect(built.rows.length).toBeGreaterThan(0);
    const queues: QueryResult<QueueRow> = await queryAs<QueueRow>(database.admin, QUEUE_COLUMNS);
    expect(queues.rows.map((queue: QueueRow): string => queue.name)).toEqual([
      'reminders',
      'reminders.dead-letter',
    ]);
  });
});
