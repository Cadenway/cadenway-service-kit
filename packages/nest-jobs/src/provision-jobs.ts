import { setTimeout as sleep } from 'node:timers/promises';

import { Logger } from '@nestjs/common';
import { Client, type QueryResult } from 'pg';
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
 * The runtime reads and writes every pg-boss table (jobs, queues, schedules, the interval claims of
 * the version table, the instance registry) and calls its functions; it never creates, alters or
 * drops an object. So the role gets usage of the schema, data access to its tables, and execution
 * of its functions, but not CREATE on the schema, TRUNCATE, REFERENCES or TRIGGER. The default
 * privileges cover objects the migrator role creates later in the schema, such as the table of a
 * future pg-boss version. Both names were validated as plain lowercase identifiers.
 *
 * @param {string} schema - Schema that holds the pg-boss tables.
 * @param {string} appRole - Role the runtime connects as.
 * @returns {readonly string[]} GRANT statements, in execution order.
 */
function grantStatements(schema: string, appRole: string): readonly string[] {
  const target: string = `SCHEMA "${schema}" TO "${appRole}"`;
  const later: string = `ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT`;
  return [
    `GRANT USAGE ON ${target}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN ${target}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN ${target}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN ${target}`,
    `${later} SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${appRole}"`,
    `${later} USAGE, SELECT ON SEQUENCES TO "${appRole}"`,
    `${later} EXECUTE ON FUNCTIONS TO "${appRole}"`,
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
  await client.query('BEGIN');
  try {
    for (const statement of grantStatements(schema, appRole)) {
      await client.query(statement);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
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
 * @param {ProvisionJobsOptions} options - Migrator connection, queue declarations and target role.
 * @returns {Promise<void>} Resolves once the schema, the queues and the grants are in place and
 * every connection is closed.
 * @throws {Error} When an option is invalid, the application role does not exist, the migrator role
 * lacks a right, or the index builds do not finish in time.
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
