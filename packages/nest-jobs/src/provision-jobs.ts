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
import { expectedSchemaVersion } from './pg-boss-schema.js';
import {
  assertIndexBuildClaim,
  closeMigratorInputs,
  closeSchemaForInstall,
  grantRuntimeAccess,
  guardQueueRows,
  holdIndexBuilds,
  isInstalled,
  readStoredVersion,
} from './schema-access.js';

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
 * Installs or migrates the pg-boss schema, lets the caller check the result before any index build
 * runs, waits for the index builds, then creates or updates the dead-letter queues and the declared
 * queues. The schema already exists: pg-boss never creates it. The pg-boss instance runs no
 * supervision, no schedule and no worker, and is stopped before returning.
 *
 * @param {JobsConnectionOptions} connection - Connection of the migrator role.
 * @param {string} schema - Schema that holds the pg-boss tables.
 * @param {readonly ResolvedJobQueue[]} queues - Resolved queues of the service.
 * @param {number} migrationTimeoutMs - Time the index builds get to finish, in milliseconds.
 * @param {() => Promise<void>} afterStart - Runs once the schema is installed or migrated, before
 * the wait for the index builds; a rejection ends the run.
 * @returns {Promise<number | null>} The installed pg-boss schema version.
 */
async function installSchemaAndQueues(
  connection: JobsConnectionOptions,
  schema: string,
  queues: readonly ResolvedJobQueue[],
  migrationTimeoutMs: number,
  afterStart: () => Promise<void>,
): Promise<number | null> {
  const boss: PgBoss = new PgBoss({
    ...connection,
    schema,
    max: JOBS_POOL_SIZE,
    migrate: true,
    createSchema: false,
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
    await afterStart();
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
 * The application role never reaches what the migrator role executes, even with platform default
 * privileges that open every new object of the migrator role to it. On a first install the
 * provisioning creates the schema itself and closes it to every other role before pg-boss
 * installs; on an installed schema it holds the index builds of pg-boss back until `bam` and
 * `version` were checked after the migration. When the application role is the role connected
 * here, no access is managed at all, which only suits a local stack with a single role.
 *
 * @param {ProvisionJobsOptions} options - Migrator connection, queue declarations and target role.
 * @returns {Promise<void>} Resolves once the schema, the queues and the grants are in place and
 * every connection is closed.
 * @throws {Error} When an option is invalid, the application role does not exist, the stored
 * schema is newer than this package or older than its index builds, the queue table holds foreign
 * rows, a role that can use the schema can write `bam` or `version`, the migrator role lacks a
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
    const identity: QueryResult<{ role: string }> = await client.query<{ role: string }>(
      'SELECT current_user::text AS role',
    );
    const managed: boolean = identity.rows[0]?.role !== appRole;
    if (!managed) {
      logger.warn(
        `provisionJobs is connected as "${appRole}", the application role itself: no access is managed. Use a migrator role of its own anywhere but on a local stack.`,
      );
    }
    const expected: number = expectedSchemaVersion();
    let installed: boolean = await isInstalled(client, schema);
    if (!installed) {
      // False when a provisioning run started together with this one installed pg-boss meanwhile.
      installed = !(await closeSchemaForInstall(client, schema, appRole, managed));
    }
    if (installed) {
      const stored: number | null = await readStoredVersion(client, schema);
      if (stored !== null && stored > expected) {
        throw new Error(
          `Schema "${schema}" is at pg-boss version ${String(stored)}, newer than the version ${String(expected)} of this package: nothing was changed. Provision with the release of the kit that brought that version.`,
        );
      }
      if (managed) {
        await assertIndexBuildClaim(client, schema, stored);
        await guardQueueRows(client, schema, appRole, stored !== null && stored < expected);
        await holdIndexBuilds(client, schema, appRole);
      }
    }
    const version: number | null = await installSchemaAndQueues(
      connection,
      schema,
      queues,
      migrationTimeoutMs,
      async (): Promise<void> => {
        if (managed) {
          await closeMigratorInputs(client, schema, installed);
        }
      },
    );
    if (managed) {
      await grantRuntimeAccess(client, schema, appRole);
    }
    logger.log(
      managed
        ? `Schema "${schema}" is at pg-boss version ${String(version)} with ${String(queues.length)} queue(s); role "${appRole}" has runtime access.`
        : `Schema "${schema}" is at pg-boss version ${String(version)} with ${String(queues.length)} queue(s); no access was managed.`,
    );
  } finally {
    await client.end();
  }
}
