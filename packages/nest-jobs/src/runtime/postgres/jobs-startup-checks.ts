import type { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { PgBoss, type QueueResult, type Schedule } from 'pg-boss';

import type { ResolvedJobsModuleOptions } from '../../jobs/configuration/jobs-options.js';
import type { ResolvedJobsRuntimeOptions } from '../../jobs/configuration/jobs-runtime-options.js';
import type { JobsQueryResult } from '../../jobs/database/jobs-transaction.js';
import type { ResolvedDeadLetterQueue, ResolvedJobQueue } from '../../jobs/queues/job-queue.js';
import { expectedSchemaVersion } from '../../schema/pg-boss-schema.js';
import { fieldOf } from './database-row.js';
import { JobsNotProvisionedError } from './jobs-not-provisioned.error.js';

/**
 * Constant PROVISION_HINT
 *
 * @description
 * How to fix a database that is not ready for the runtime, appended to start-up errors.
 *
 * @type {string}
 */
const PROVISION_HINT: string =
  'Run provisionJobs() as the migrator role, with the same queue declarations and this role as appRole, before starting the service.';

/**
 * Constant INSUFFICIENT_PRIVILEGE
 *
 * @description
 * SQLSTATE PostgreSQL answers with when the connected role lacks a right.
 *
 * @type {string}
 */
const INSUFFICIENT_PRIVILEGE: string = '42501';

/**
 * Constant STARTUP_TIMEOUT_MS
 *
 * @description
 * Maximum time for the temporary startup connection and for each of its queries, in milliseconds.
 *
 * @type {number}
 */
const STARTUP_TIMEOUT_MS: number = 10_000;

/**
 * Function hasSqlState
 *
 * @description
 * Tells whether a thrown value is a database error carrying the given SQLSTATE.
 *
 * @param {unknown} error - Value that was thrown.
 * @param {string} code - Five-character SQLSTATE.
 * @returns {boolean} Whether the error carries that code.
 */
function hasSqlState(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/**
 * Function toStartupError
 *
 * @description
 * Gives provisioning failures an actionable error and preserves unrelated failures such as
 * network errors and timeouts.
 *
 * @param {unknown} error - Failure while checking provisioning or starting pg-boss.
 * @param {string} schema - Schema the runtime was told to use.
 * @returns {unknown} A `JobsNotProvisionedError`, or the original failure.
 */
export function toStartupError(error: unknown, schema: string): unknown {
  if (error instanceof JobsNotProvisionedError) {
    return error;
  }
  const message: string = error instanceof Error ? error.message : '';
  if (message === 'pg-boss is not installed') {
    return new JobsNotProvisionedError(
      `The pg-boss schema "${schema}" is not installed in this database. ${PROVISION_HINT}`,
      { cause: error },
    );
  }
  if (message === 'pg-boss database requires migrations') {
    return new JobsNotProvisionedError(
      `The pg-boss schema "${schema}" is not at the version this package expects. ${PROVISION_HINT}`,
      { cause: error },
    );
  }
  if (hasSqlState(error, INSUFFICIENT_PRIVILEGE)) {
    return new JobsNotProvisionedError(
      `The connected role lacks a right on the pg-boss schema "${schema}" (${message}). ${PROVISION_HINT}`,
      { cause: error },
    );
  }
  return error;
}

/**
 * Function settingsThatDiffer
 *
 * @description
 * Compares a declared queue with the row stored for it and names the settings that differ.
 *
 * @param {ResolvedJobQueue} declared - Queue as the service declares it.
 * @param {QueueResult} stored - Queue as the database holds it.
 * @returns {readonly string[]} Names of the differing settings, empty when the two agree.
 */
function settingsThatDiffer(declared: ResolvedJobQueue, stored: QueueResult): readonly string[] {
  const comparisons: readonly (readonly [string, unknown, unknown])[] = [
    ['retryLimit', declared.retryLimit, stored.retryLimit],
    ['retryDelaySeconds', declared.retryDelaySeconds, stored.retryDelay],
    ['retryBackoff', declared.retryBackoff, stored.retryBackoff],
    ['retryDelayMaxSeconds', declared.retryDelayMaxSeconds, stored.retryDelayMax ?? null],
    ['deadLetter', declared.deadLetter, stored.deadLetter ?? null],
    ['expireInSeconds', declared.expireInSeconds, stored.expireInSeconds],
    ['retentionSeconds', declared.retentionSeconds, stored.retentionSeconds],
    ['deleteAfterSeconds', declared.deleteAfterSeconds, stored.deleteAfterSeconds],
  ];
  return comparisons
    .filter((comparison: readonly [string, unknown, unknown]): boolean => {
      return comparison[1] !== comparison[2];
    })
    .map((comparison: readonly [string, unknown, unknown]): string => comparison[0]);
}

/**
 * Function assertUnprivilegedRole
 *
 * @description
 * Refuses a role with DDL access unless the runtime explicitly allows a privileged role.
 *
 * @param {PgBoss} boss - pg-boss instance bound to the temporary startup session.
 * @param {ResolvedJobsModuleOptions} options - Schema and permitted role privileges of the runtime.
 * @returns {Promise<void>} Resolves when the configured role is accepted.
 */
async function assertUnprivilegedRole(
  boss: PgBoss,
  options: ResolvedJobsModuleOptions,
): Promise<void> {
  if (options.allowPrivilegedRole) {
    return;
  }
  const result: JobsQueryResult = await boss
    .getDb()
    .executeSql(
      "SELECT pg_catalog.has_schema_privilege(current_user, $1, 'CREATE') AS privileged, current_user::text AS role",
      [options.schema],
    );
  if (fieldOf(result.rows[0], 'privileged') === true) {
    throw new Error(
      `The runtime is connected as "${String(fieldOf(result.rows[0], 'role'))}", a role that can create objects in the pg-boss schema "${options.schema}". Connect as the application role, which provisionJobs() grants data access only, or set allowPrivilegedRole for a local stack with a single role.`,
    );
  }
}

/**
 * Function warnAboutQueueSettings
 *
 * @description
 * Reports stored queue settings that require provisioning to take effect.
 *
 * @param {Logger} logger - Logger scoped to the jobs runtime.
 * @param {string} queue - Name of the declared queue.
 * @param {readonly string[]} differing - Settings whose stored values differ from their declarations.
 */
function warnAboutQueueSettings(logger: Logger, queue: string, differing: readonly string[]): void {
  if (differing.length > 0) {
    logger.warn(
      `Queue "${queue}" is stored with settings that differ from its declaration (${differing.join(', ')}). Run provisionJobs() to apply the declaration.`,
    );
  }
}

/**
 * Function assertProvisioned
 *
 * @description
 * Requires the declared queues and reports drift between declarations and stored settings.
 *
 * @param {PgBoss} boss - pg-boss instance bound to the temporary startup session.
 * @param {ResolvedJobsModuleOptions} options - Schema and declared queues of the runtime.
 * @param {readonly ResolvedDeadLetterQueue[]} deadLetterQueues - Distinct dead-letter queues expected for the declarations.
 * @param {Logger} logger - Logger for settings that differ from their declarations.
 * @returns {Promise<void>} Resolves when every declared queue and its dead-letter queue exist.
 */
async function assertProvisioned(
  boss: PgBoss,
  options: ResolvedJobsModuleOptions,
  deadLetterQueues: readonly ResolvedDeadLetterQueue[],
  logger: Logger,
): Promise<void> {
  const expected: string[] = [
    ...options.queues.map((queue: ResolvedJobQueue): string => queue.name),
    ...deadLetterQueues.map((queue: ResolvedDeadLetterQueue): string => queue.name),
  ];
  if (expected.length === 0) {
    return;
  }
  const stored: Map<string, QueueResult> = new Map<string, QueueResult>();
  for (const queue of await boss.getQueues(expected, { limit: expected.length })) {
    stored.set(queue.name, queue);
  }
  const missing: string[] = expected.filter((name: string): boolean => !stored.has(name));
  if (missing.length > 0) {
    throw new JobsNotProvisionedError(
      `These queues do not exist in the pg-boss schema "${options.schema}": ${missing.join(', ')}. ${PROVISION_HINT}`,
    );
  }
  for (const declared of options.queues) {
    const row: QueueResult | undefined = stored.get(declared.name);
    if (row !== undefined) {
      warnAboutQueueSettings(logger, declared.name, settingsThatDiffer(declared, row));
    }
  }
  for (const declared of deadLetterQueues) {
    const row: QueueResult | undefined = stored.get(declared.name);
    if (row !== undefined && row.retentionSeconds !== declared.retentionSeconds) {
      warnAboutQueueSettings(logger, declared.name, ['deadLetterRetentionSeconds']);
    }
  }
}

/**
 * Function warnAboutUndeclaredSchedules
 *
 * @description
 * Reports schedules the application may still need to remove after dropping a declaration.
 *
 * @param {PgBoss} boss - pg-boss instance bound to the temporary startup session.
 * @param {ResolvedJobsModuleOptions} options - Queue declarations that identify which schedules belong to the process.
 * @param {Logger} logger - Logger for schedules that still target an undeclared queue.
 * @returns {Promise<void>} Resolves once any stale schedule warnings have been logged.
 */
async function warnAboutUndeclaredSchedules(
  boss: PgBoss,
  options: ResolvedJobsModuleOptions,
  logger: Logger,
): Promise<void> {
  const declaredNames: ReadonlySet<string> = new Set(
    options.queues.map((queue: ResolvedJobQueue): string => queue.name),
  );
  const schedules: Schedule[] = await boss.getSchedules();
  for (const schedule of schedules) {
    if (!declaredNames.has(schedule.name)) {
      logger.warn(
        `A schedule is stored for queue "${schedule.name}" (key "${schedule.key}"), which is not declared: it still creates jobs that nothing consumes. Remove it with unschedule(), or declare the queue.`,
      );
    }
  }
}

/**
 * Function verifyJobsDatabase
 *
 * @description
 * Checks the application role, schema version and queue declarations before starting pg-boss.
 * The temporary session bounds both connection and per-query time and is closed before activation.
 *
 * @param {ResolvedJobsRuntimeOptions} options - Resolved capabilities, application connection and queue declarations.
 * @param {readonly ResolvedDeadLetterQueue[]} deadLetterQueues - Distinct dead-letter queues expected for the declarations.
 * @param {Logger} logger - Logger for provisioned settings that need attention.
 * @returns {Promise<void>} Resolves once checks pass and the temporary session closes.
 * @throws {JobsNotProvisionedError} When the schema, a grant or a declared queue is missing, or the schema version does not match.
 * @throws {Error} When the role is not allowed or the connection or query times out.
 */
export async function verifyJobsDatabase(
  options: ResolvedJobsRuntimeOptions,
  deadLetterQueues: readonly ResolvedDeadLetterQueue[],
  logger: Logger,
): Promise<void> {
  const client: Client = new Client({
    ...options.connection,
    connectionTimeoutMillis: STARTUP_TIMEOUT_MS,
    statement_timeout: STARTUP_TIMEOUT_MS,
  });
  // pg also emits connection failures as events, even when it rejects the active query.
  let connectionError: Error | undefined;
  client.on('error', (error: Error): void => {
    connectionError = error;
  });
  try {
    await client.connect();
    const boss: PgBoss = new PgBoss({
      schema: options.schema,
      db: {
        executeSql: (text: string, values?: unknown[]): Promise<JobsQueryResult> => {
          // The per-query deadline takes precedence over settings supplied in the connection URI.
          const query = { text, values, query_timeout: STARTUP_TIMEOUT_MS };
          return client.query(query);
        },
      },
    });
    if (!(await boss.isInstalled())) {
      throw new Error('pg-boss is not installed');
    }
    if ((await boss.schemaVersion()) !== expectedSchemaVersion()) {
      throw new Error('pg-boss database requires migrations');
    }
    await assertUnprivilegedRole(boss, options);
    await assertProvisioned(boss, options, deadLetterQueues, logger);
    if (options.capabilities.has('scheduler')) {
      await warnAboutUndeclaredSchedules(boss, options, logger);
    }
    if (connectionError !== undefined) {
      throw connectionError;
    }
  } catch (error) {
    throw toStartupError(connectionError ?? error, options.schema);
  } finally {
    await client.end();
  }
}
