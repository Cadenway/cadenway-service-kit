import { Logger } from '@nestjs/common';
import { Client, type QueryResult } from 'pg';
import { PgBoss } from 'pg-boss';

import {
  JOBS_POOL_SIZE,
  assertConnection,
  type JobsConnectionOptions,
} from '../jobs/database/jobs-connection.js';
import { describeError } from '../jobs/diagnostics/describe-error.js';
import { resolveJobQueues, type ResolvedJobQueue } from '../jobs/queues/job-queue.js';
import { DEFAULT_JOBS_SCHEMA, assertRoleName, assertSchemaName } from '../schema/jobs-schema.js';
import { expectedSchemaVersion } from '../schema/pg-boss-schema.js';
import type { ProvisionJobsOptions } from './provision-jobs-options.js';
import { provisionQueues } from './queues/provision-queues.js';
import {
  closeMigratorInputs,
  closeSchemaForInstall,
  holdIndexBuilds,
} from './schema/migration-guards.js';
import { guardQueueRows } from './schema/queue-migration-guard.js';
import { grantRuntimeAccess } from './schema/runtime-grants.js';
import {
  assertIndexBuildClaim,
  isInstalled,
  readStoredVersion,
} from './schema/schema-inspection.js';
import { waitForIndexBuilds } from './schema/wait-for-index-builds.js';

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
 * Constant logger
 *
 * @description
 * Logger of the provisioning run. Works outside a NestJS application, as in a migration script.
 *
 * @type {Logger}
 */
const logger: Logger = new Logger('JobsProvisioning');

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
 *   the wait for the index builds; a rejection ends the run.
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
    await provisionQueues(boss, queues);
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
 *   every connection is closed.
 * @throws {Error} When an option is invalid, the application role does not exist, the stored
 *   schema is newer than this package or older than its index builds, the queue table holds foreign
 *   rows, a role that can use the schema can write `bam` or `version`, the migrator role lacks a
 *   right, or the index builds do not finish in time.
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
