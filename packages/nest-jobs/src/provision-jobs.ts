import { setTimeout as sleep } from 'node:timers/promises';

import { Logger } from '@nestjs/common';
import { Client, escapeIdentifier, type QueryResult } from 'pg';
import {
  PgBoss,
  type BamEntry,
  type BamStatusSummary,
  type Queue,
  type QueueResult,
  type UpdateQueueOptions,
} from 'pg-boss';

import {
  DEFAULT_DELETE_AFTER_SECONDS,
  DEFAULT_EXPIRE_IN_SECONDS,
  deadLetterQueuesOf,
  resolveJobQueues,
  type JobQueueDeclaration,
  type ResolvedDeadLetterQueue,
  type ResolvedJobQueue,
} from './job-queue.js';
import {
  DEFAULT_JOBS_SCHEMA,
  JOBS_POOL_SIZE,
  assertConnection,
  assertRoleName,
  assertSchemaName,
  type JobsConnectionOptions,
} from './jobs-options.js';
import { describeError } from './describe-error.js';
import { expectedSchemaVersion } from './pg-boss-schema.js';
import { inProvisioningTransaction } from './provisioning-transaction.js';

/**
 * Constant DEFAULT_MIGRATION_TIMEOUT_MS
 *
 * @description
 * Time the index builds of a pg-boss schema migration get to finish, 10 minutes in milliseconds.
 *
 * @type {number}
 */
const DEFAULT_MIGRATION_TIMEOUT_MS: number = 600_000;

/**
 * Constant MIGRATION_POLL_INTERVAL_MS
 *
 * @description
 * Pause between two readings of the pending index builds, in milliseconds.
 *
 * @type {number}
 */
const MIGRATION_POLL_INTERVAL_MS: number = 1_000;

/**
 * Constant BAM_INTERVAL_SECONDS
 *
 * @description
 * How often pg-boss looks for index builds to run or retry during provisioning, in seconds: the
 * lowest value it accepts, so a one-off container does not wait a minute between two tries.
 *
 * @type {number}
 */
const BAM_INTERVAL_SECONDS: number = 10;

/**
 * Constant STANDARD_POLICY
 *
 * @description
 * The pg-boss queue policy this package relies on: no limit on queued or active jobs, so the only
 * deduplication is the occurrence key.
 *
 * @type {string}
 */
const STANDARD_POLICY: string = 'standard';

/**
 * Constant SHARED_JOB_TABLE
 *
 * @description
 * Table pg-boss stores the jobs of every queue that is not partitioned in. This package creates no
 * other kind of queue.
 *
 * @type {string}
 */
const SHARED_JOB_TABLE: string = 'job_common';

/**
 * Constant QUEUE_LOCK_TIMEOUT_MS
 *
 * @description
 * Time the provisioning waits for the writes in flight on the queue table before a migration, in
 * milliseconds.
 *
 * @type {number}
 */
const QUEUE_LOCK_TIMEOUT_MS: number = 30_000;

/**
 * Constant logger
 *
 * @description
 * Logger of the provisioning run. Works outside a NestJS application, as in a migration script.
 *
 * @type {Logger}
 */
const logger: Logger = new Logger('JobsProvisioning');

/**
 * Interface ProvisionJobsOptions
 *
 * @description
 * Options of one provisioning run. `connection`, `queues` and `appRole` are required.
 */
export interface ProvisionJobsOptions {
  // #region Properties
  /**
   * Property connection
   *
   * @description
   * Connection of the migrator role. The role must be allowed to create the schema, or own it when
   * it already exists, and to create objects in it.
   *
   * @type {JobsConnectionOptions}
   * @readonly
   */
  readonly connection: JobsConnectionOptions;

  /**
   * Property queues
   *
   * @description
   * The queues of the service, the same list given to `JobsModule`. Each is created, or updated to
   * match its declaration, with its dead-letter queue. A queue removed from the list is left in
   * place.
   *
   * @type {readonly JobQueueDeclaration[]}
   * @readonly
   */
  readonly queues: readonly JobQueueDeclaration[];

  /**
   * Property appRole
   *
   * @description
   * Existing role the runtime connects as: lowercase letters, digits and underscores. It is granted
   * usage of the schema and data access to its tables, never DDL rights.
   *
   * @type {string}
   * @readonly
   */
  readonly appRole: string;

  /**
   * Property schema
   *
   * @description
   * PostgreSQL schema that holds the pg-boss tables: lowercase letters, digits and underscores.
   * Defaults to `pgboss`.
   *
   * @type {string}
   * @readonly
   */
  readonly schema?: string;

  /**
   * Property migrationTimeoutMs
   *
   * @description
   * Time the index builds of a pg-boss schema migration get to finish, in milliseconds. Past it the
   * run fails and can be started again. Defaults to 600000 (10 minutes).
   *
   * @type {number}
   * @readonly
   */
  readonly migrationTimeoutMs?: number;
  // #endregion
}

/**
 * Function toCreateOptions
 *
 * @description
 * Maps a resolved queue to the options pg-boss creates it with. Every value is explicit so a
 * change of a pg-boss default cannot change a queue silently.
 *
 * @param {ResolvedJobQueue} queue - Resolved queue declaration.
 * @returns {Omit<Queue, 'name'>} Options for `createQueue`.
 */
function toCreateOptions(queue: ResolvedJobQueue): Omit<Queue, 'name'> {
  return {
    policy: STANDARD_POLICY,
    retryLimit: queue.retryLimit,
    retryDelay: queue.retryDelaySeconds,
    retryBackoff: queue.retryBackoff,
    ...(queue.retryDelayMaxSeconds === null ? {} : { retryDelayMax: queue.retryDelayMaxSeconds }),
    expireInSeconds: queue.expireInSeconds,
    retentionSeconds: queue.retentionSeconds,
    deleteAfterSeconds: queue.deleteAfterSeconds,
    deadLetter: queue.deadLetter,
  };
}

/**
 * Function toUpdateOptions
 *
 * @description
 * Maps a resolved queue to the options an existing queue is updated with, so a changed declaration
 * reaches the database at the next provisioning run. Jobs already stored keep the retry policy they
 * were enqueued with.
 *
 * @param {ResolvedJobQueue} queue - Resolved queue declaration.
 * @returns {UpdateQueueOptions} Options for `updateQueue`.
 */
function toUpdateOptions(queue: ResolvedJobQueue): UpdateQueueOptions {
  return {
    retryLimit: queue.retryLimit,
    retryDelay: queue.retryDelaySeconds,
    retryBackoff: queue.retryBackoff,
    retryDelayMax: queue.retryDelayMaxSeconds,
    expireInSeconds: queue.expireInSeconds,
    retentionSeconds: queue.retentionSeconds,
    deleteAfterSeconds: queue.deleteAfterSeconds,
    deadLetter: queue.deadLetter,
  };
}

/**
 * Type DeadLetterQueueOptions
 *
 * @description
 * The options a dead-letter queue is created and updated with: the subset both pg-boss calls
 * accept unchanged.
 *
 * @type {Required<Pick<Queue, 'retryLimit' | 'retryDelay' | 'retryBackoff' | 'expireInSeconds' | 'retentionSeconds' | 'deleteAfterSeconds'>>}
 */
type DeadLetterQueueOptions = Required<
  Pick<
    Queue,
    | 'retryLimit'
    | 'retryDelay'
    | 'retryBackoff'
    | 'expireInSeconds'
    | 'retentionSeconds'
    | 'deleteAfterSeconds'
  >
>;

/**
 * Function toDeadLetterOptions
 *
 * @description
 * Options of a dead-letter queue: a parking place. Nothing consumes it, so it has no retry and no
 * dead-letter queue of its own, and a dead letter is deleted once its retention has passed.
 *
 * @param {ResolvedDeadLetterQueue} deadLetter - Dead-letter queue derived from the declarations.
 * @returns {DeadLetterQueueOptions} Options valid for both `createQueue` and `updateQueue`.
 */
function toDeadLetterOptions(deadLetter: ResolvedDeadLetterQueue): DeadLetterQueueOptions {
  return {
    retryLimit: 0,
    retryDelay: 0,
    retryBackoff: false,
    expireInSeconds: DEFAULT_EXPIRE_IN_SECONDS,
    retentionSeconds: deadLetter.retentionSeconds,
    deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS,
  };
}

/**
 * Function ensureQueue
 *
 * @description
 * Creates a queue, or updates it when it already exists. Safe to run from two containers at once:
 * pg-boss creates a queue with `ON CONFLICT DO NOTHING` under an advisory lock.
 *
 * @param {PgBoss} boss - Started pg-boss instance of the migrator role.
 * @param {string} name - Queue name.
 * @param {Omit<Queue, 'name'>} createOptions - Options used when the queue does not exist.
 * @param {UpdateQueueOptions} updateOptions - Options applied when it does.
 * @returns {Promise<void>} Resolves once the queue matches its declaration.
 * @throws {Error} When an existing queue has another policy than the one this package relies on.
 */
async function ensureQueue(
  boss: PgBoss,
  name: string,
  createOptions: Omit<Queue, 'name'>,
  updateOptions: UpdateQueueOptions,
): Promise<void> {
  const existing: QueueResult | null = await boss.getQueue(name);
  if (existing === null) {
    await boss.createQueue(name, createOptions);
    return;
  }
  if (existing.policy !== STANDARD_POLICY) {
    throw new Error(
      `Queue "${name}" exists with policy "${String(existing.policy)}": only "${STANDARD_POLICY}" queues are supported.`,
    );
  }
  await boss.updateQueue(name, updateOptions);
}

/**
 * Function waitForIndexBuilds
 *
 * @description
 * Waits until pg-boss has run every index build a schema migration queued.
 *
 * A migration creates its indexes in the background, one `CREATE INDEX CONCURRENTLY` at a time, and
 * only an instance allowed to migrate runs them. The runtime is not, so they must finish here. A
 * failed build is retried by pg-boss; the wait only ends when none is left or the time is up. A
 * fresh install queues none.
 *
 * @param {PgBoss} boss - Started pg-boss instance of the migrator role.
 * @param {string} schema - Schema name, used in the error message.
 * @param {number} timeoutMs - Time the builds get to finish, in milliseconds.
 * @returns {Promise<void>} Resolves once no build is pending, running or failed.
 * @throws {Error} When builds are still unfinished after the timeout.
 */
async function waitForIndexBuilds(boss: PgBoss, schema: string, timeoutMs: number): Promise<void> {
  const deadline: number = Date.now() + timeoutMs;
  for (;;) {
    const statuses: BamStatusSummary[] = await boss.getBamStatus();
    const unfinished: number = statuses
      .filter((status: BamStatusSummary): boolean => status.status !== 'completed')
      .reduce((total: number, status: BamStatusSummary): number => total + status.count, 0);
    if (unfinished === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      const entries: BamEntry[] = await boss.getBamEntries();
      const details: string = entries
        .filter((entry: BamEntry): boolean => entry.status !== 'completed')
        .map((entry: BamEntry): string => `${entry.name} (${entry.status}): ${entry.error ?? '-'}`)
        .join('; ');
      throw new Error(
        `${String(unfinished)} index build(s) of schema "${schema}" did not finish in ${String(timeoutMs)} ms: ${details}. Run the provisioning again.`,
      );
    }
    await sleep(MIGRATION_POLL_INTERVAL_MS);
  }
}

/**
 * Function grantStatements
 *
 * @description
 * Lists the statements that give the application role what the runtime needs and nothing more.
 *
 * The runtime reads and writes the pg-boss tables (jobs, queues, schedules, the instance registry)
 * and calls its functions; it never creates, alters or drops an object. So the role gets usage of
 * the schema, data access to its tables and execution of its functions, but not CREATE on the
 * schema, TRUNCATE, REFERENCES or TRIGGER. Two tables are then narrowed, because the migrator role
 * acts on what they hold:
 *
 * - `bam` lists the statements pg-boss runs, verbatim, as the role that migrates. The runtime never
 *   reads or writes it, so the application role keeps no right on it. With one, a compromised
 *   service could have the next provisioning run a statement of its choice as the migrator role.
 * - `version` holds the installed schema version, which decides the migrations to run, and the
 *   interval claims of the background passes. The runtime only reads it and stamps the claims, so
 *   the role keeps SELECT and gets UPDATE on the claim columns alone.
 *
 * No default privilege is set: a table of a later pg-boss version is granted by the provisioning
 * run that creates it, after it was looked at here. Both names were validated as plain lowercase
 * identifiers and the column names are quoted.
 *
 * @param {string} schema - Schema that holds the pg-boss tables.
 * @param {string} appRole - Role the runtime connects as.
 * @param {readonly string[]} claimColumns - Columns of `version` other than the version itself.
 * @returns {readonly string[]} Statements, in execution order.
 */
function grantStatements(
  schema: string,
  appRole: string,
  claimColumns: readonly string[],
): readonly string[] {
  const target: string = `SCHEMA "${schema}" TO "${appRole}"`;
  const columns: string = claimColumns
    .map((column: string): string => escapeIdentifier(column))
    .join(', ');
  return [
    `GRANT USAGE ON ${target}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN ${target}`,
    `REVOKE ALL PRIVILEGES ON TABLE "${schema}".bam FROM "${appRole}"`,
    `REVOKE INSERT, UPDATE, DELETE ON TABLE "${schema}".version FROM "${appRole}"`,
    ...(columns === ''
      ? []
      : [`GRANT UPDATE (${columns}) ON TABLE "${schema}".version TO "${appRole}"`]),
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN ${target}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN ${target}`,
  ];
}

/**
 * Function grantRuntimeAccess
 *
 * @description
 * Applies the grants in one transaction, so the application role never sees half of them.
 *
 * @param {Client} client - Connection of the migrator role.
 * @param {string} schema - Schema that holds the pg-boss tables.
 * @param {string} appRole - Role the runtime connects as.
 * @returns {Promise<void>} Resolves once the grants are committed.
 */
async function grantRuntimeAccess(client: Client, schema: string, appRole: string): Promise<void> {
  await inProvisioningTransaction(client, schema, async (): Promise<void> => {
    const columns: QueryResult<{ column_name: string }> = await client.query<{
      column_name: string;
    }>(
      `SELECT column_name::text AS column_name
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'version' AND column_name <> 'version'
       ORDER BY ordinal_position`,
      [schema],
    );
    const claimColumns: string[] = columns.rows.map(
      (row: { column_name: string }): string => row.column_name,
    );
    for (const statement of grantStatements(schema, appRole, claimColumns)) {
      await client.query(statement);
    }
  });
}

/**
 * Function readStoredVersion
 *
 * @description
 * Reads the pg-boss schema version stored in the database, before pg-boss is started.
 *
 * @param {Client} client - Connection of the migrator role.
 * @param {string} schema - Schema that holds the pg-boss tables.
 * @returns {Promise<number | null>} The stored version, or `null` when pg-boss is not installed.
 */
async function readStoredVersion(client: Client, schema: string): Promise<number | null> {
  const installed: QueryResult<{ installed: boolean }> = await client.query<{
    installed: boolean;
  }>('SELECT pg_catalog.to_regclass($1) IS NOT NULL AS installed', [`"${schema}".version`]);
  if (installed.rows[0]?.installed !== true) {
    return null;
  }
  const stored: QueryResult<{ version: number }> = await client.query<{ version: number }>(
    `SELECT version FROM "${schema}".version`,
  );
  return stored.rows[0]?.version ?? null;
}

/**
 * Function guardQueueRows
 *
 * @description
 * Makes sure no row of the queue table can steer what the migrator role is about to run.
 *
 * A pg-boss migration loops over the rows of `queue` flagged as partitioned and executes DDL built
 * from their `table_name`. The runtime needs INSERT and UPDATE on `queue`, so a compromised
 * service could plant such a row. This package never creates a partitioned queue: any row that is
 * partitioned, or that names another table than the shared one, is refused, on every run.
 *
 * When a migration is pending the check must also hold until the migration ran. The application
 * role first loses its write access to `queue`, which the grants give back at the end of the run;
 * then a lock on the table waits for the writes already in flight, and the rows are checked under
 * it. Meanwhile a running service keeps enqueuing and working jobs, which do not write to `queue`;
 * only its supervision passes and a restart fail until the run ends.
 *
 * @param {Client} client - Connection of the migrator role.
 * @param {string} schema - Schema that holds the pg-boss tables.
 * @param {string} appRole - Role the runtime connects as.
 * @param {boolean} migrationPending - Whether pg-boss is about to migrate the schema.
 * @returns {Promise<void>} Resolves when the queue table holds only rows this package creates.
 * @throws {Error} When a queue row is partitioned or names another job table.
 */
async function guardQueueRows(
  client: Client,
  schema: string,
  appRole: string,
  migrationPending: boolean,
): Promise<void> {
  if (migrationPending) {
    await inProvisioningTransaction(client, schema, async (): Promise<void> => {
      await client.query(
        `REVOKE INSERT, UPDATE, DELETE ON TABLE "${schema}".queue FROM "${appRole}"`,
      );
    });
  }
  let foreign: string[] = [];
  await inProvisioningTransaction(client, schema, async (): Promise<void> => {
    if (migrationPending) {
      await client.query(`SET LOCAL lock_timeout = '${String(QUEUE_LOCK_TIMEOUT_MS)}ms'`);
      await client.query(`LOCK TABLE "${schema}".queue IN SHARE ROW EXCLUSIVE MODE`);
    }
    const rows: QueryResult<{ name: string }> = await client.query<{ name: string }>(
      `SELECT name FROM "${schema}".queue
       WHERE partition IS DISTINCT FROM false OR table_name IS DISTINCT FROM $1
       ORDER BY name LIMIT 10`,
      [SHARED_JOB_TABLE],
    );
    foreign = rows.rows.map((row: { name: string }): string => JSON.stringify(row.name));
  });
  if (foreign.length > 0) {
    throw new Error(
      `The queue table of schema "${schema}" holds rows this package does not create (partitioned, or on another job table): ${foreign.join(', ')}. Nothing was installed or migrated. Inspect these rows: a migration would run DDL built from them.`,
    );
  }
}

/**
 * Function stopQuietly
 *
 * @description
 * Stops the provisioning instance and closes its pool. A failure to stop is logged instead of
 * thrown, so it never hides the error that ended the run.
 *
 * @param {PgBoss} boss - pg-boss instance of the migrator role, started or not.
 * @returns {Promise<void>} Resolves once the stop was attempted.
 */
async function stopQuietly(boss: PgBoss): Promise<void> {
  try {
    await boss.stop();
  } catch (error) {
    logger.error(`pg-boss did not stop cleanly after provisioning: ${describeError(error)}`);
  }
}

/**
 * Function installSchemaAndQueues
 *
 * @description
 * Installs or migrates the pg-boss schema, waits for its index builds, then creates or updates the
 * dead-letter queues and the declared queues. The pg-boss instance runs no supervision, no schedule
 * and no worker, and is stopped before returning.
 *
 * @param {JobsConnectionOptions} connection - Connection of the migrator role.
 * @param {string} schema - Schema that holds the pg-boss tables.
 * @param {boolean} createSchema - Whether the schema itself still has to be created.
 * @param {readonly ResolvedJobQueue[]} queues - Resolved queues of the service.
 * @param {number} migrationTimeoutMs - Time the index builds get to finish, in milliseconds.
 * @returns {Promise<number | null>} The installed pg-boss schema version.
 */
async function installSchemaAndQueues(
  connection: JobsConnectionOptions,
  schema: string,
  createSchema: boolean,
  queues: readonly ResolvedJobQueue[],
  migrationTimeoutMs: number,
): Promise<number | null> {
  const boss: PgBoss = new PgBoss({
    ...connection,
    schema,
    max: JOBS_POOL_SIZE,
    migrate: true,
    createSchema,
    supervise: false,
    schedule: false,
    registerInstance: false,
    bamIntervalSeconds: BAM_INTERVAL_SECONDS,
  });
  boss.on('error', (error: Error): void => {
    logger.error(`pg-boss reported an error during provisioning: ${error.message}`, error.stack);
  });
  try {
    await boss.start();
    await waitForIndexBuilds(boss, schema, migrationTimeoutMs);
    for (const deadLetter of deadLetterQueuesOf(queues)) {
      const options: DeadLetterQueueOptions = toDeadLetterOptions(deadLetter);
      await ensureQueue(
        boss,
        deadLetter.name,
        { ...options, policy: STANDARD_POLICY },
        { ...options, deadLetter: null, retryDelayMax: null },
      );
    }
    for (const queue of queues) {
      await ensureQueue(boss, queue.name, toCreateOptions(queue), toUpdateOptions(queue));
    }
    return await boss.schemaVersion();
  } finally {
    await stopQuietly(boss);
  }
}

/**
 * Function provisionJobs
 *
 * @description
 * Prepares the database for the runtime. Call it from the one-off migration entry point of a
 * service, connected as the migrator role, before the service starts.
 *
 * It installs the pg-boss schema or migrates it to the version this package expects, waits for the
 * index builds of a migration, creates or updates the declared queues and their dead-letter queues,
 * and grants the application role data access to the schema. It runs every DDL statement the jobs
 * need: the runtime runs none. It is idempotent and safe to run on every deployment.
 *
 * It refuses to go on, before changing anything, when the stored schema is newer than the pg-boss
 * version of this package, or when the queue table holds rows this package does not create.
 *
 * @param {ProvisionJobsOptions} options - Migrator connection, queue declarations and target role.
 * @returns {Promise<void>} Resolves once the schema, the queues and the grants are in place and
 * every connection is closed.
 * @throws {Error} When an option is invalid, the application role does not exist, the stored
 * schema is newer than this package, the queue table holds foreign rows, the migrator role lacks a
 * right, or the index builds do not finish in time.
 */
export async function provisionJobs(options: ProvisionJobsOptions): Promise<void> {
  const connection: unknown = options.connection;
  assertConnection(connection);
  const schema: unknown = options.schema ?? DEFAULT_JOBS_SCHEMA;
  assertSchemaName(schema);
  const appRole: unknown = options.appRole;
  assertRoleName(appRole);
  const migrationTimeoutMs: number = options.migrationTimeoutMs ?? DEFAULT_MIGRATION_TIMEOUT_MS;
  if (!Number.isInteger(migrationTimeoutMs) || migrationTimeoutMs < 1_000) {
    throw new Error('migrationTimeoutMs must be an integer of at least 1000.');
  }
  const queues: readonly ResolvedJobQueue[] = resolveJobQueues(options.queues);

  const client: Client = new Client({ ...connection });
  client.on('error', (error: Error): void => {
    logger.error(`The provisioning connection failed: ${error.message}`, error.stack);
  });
  await client.connect();
  try {
    const roles: QueryResult = await client.query(
      'SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1',
      [appRole],
    );
    if (roles.rows.length === 0) {
      throw new Error(`Role "${appRole}" does not exist: create it before provisioning the jobs.`);
    }
    const schemas: QueryResult = await client.query(
      'SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1',
      [schema],
    );
    const expected: number = expectedSchemaVersion();
    const stored: number | null =
      schemas.rows.length === 0 ? null : await readStoredVersion(client, schema);
    if (stored !== null && stored > expected) {
      throw new Error(
        `Schema "${schema}" is at pg-boss version ${String(stored)}, newer than the version ${String(expected)} of this package: nothing was changed. Provision with the release of the kit that brought that version.`,
      );
    }
    if (stored !== null) {
      await guardQueueRows(client, schema, appRole, stored < expected);
    }
    const version: number | null = await installSchemaAndQueues(
      connection,
      schema,
      schemas.rows.length === 0,
      queues,
      migrationTimeoutMs,
    );
    await grantRuntimeAccess(client, schema, appRole);
    logger.log(
      `Schema "${schema}" is at pg-boss version ${String(version)} with ${String(queues.length)} queue(s); role "${appRole}" has runtime access.`,
    );
  } finally {
    await client.end();
  }
}
