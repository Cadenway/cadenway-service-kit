import { assertSchemaName, DEFAULT_JOBS_SCHEMA } from '../../schema/jobs-schema.js';

import { assertConnection, type JobsConnectionOptions } from '../database/jobs-connection.js';
import {
  resolveJobQueues,
  type JobQueueDeclaration,
  type ResolvedJobQueue,
} from '../queues/job-queue.js';

/**
 * Constant DEFAULT_SHUTDOWN_TIMEOUT_MS
 *
 * @description
 * Time running handlers get to finish at shutdown before their attempts are failed, in
 * milliseconds.
 *
 * @type {number}
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS: number = 30_000;

/**
 * Constant DEFAULT_DEAD_LETTER_CHECK_INTERVAL_SECONDS
 *
 * @description
 * Seconds between checks of the jobs retained in the dead-letter queues.
 *
 * @type {number}
 */
export const DEFAULT_DEAD_LETTER_CHECK_INTERVAL_SECONDS: number = 60;

/**
 * Constant MAX_DEAD_LETTER_CHECK_INTERVAL_SECONDS
 *
 * @description
 * Largest whole-second interval representable by a Node timer.
 *
 * @type {number}
 */
const MAX_DEAD_LETTER_CHECK_INTERVAL_SECONDS: number = 2_147_483;

/**
 * Type RunInOrganization
 *
 * @description
 * Wraps the handling of one job in the context of its organization, for example the organization
 * context of `@cadenway/nest-common`. It must call `work` exactly once and resolve or reject with
 * it.
 *
 * @type {(organizationId: string | null, work: () => Promise<void>) => Promise<void>}
 * @param {string | null} organizationId - Organization of the job, or null when it has no organization.
 * @param {() => Promise<void>} work - Handler invocation that must run exactly once within the context.
 * @returns {Promise<void>} Settles with the enclosed handler invocation.
 */
export type RunInOrganization = (
  organizationId: string | null,
  work: () => Promise<void>,
) => Promise<void>;

/**
 * Interface JobsModuleOptions
 *
 * @description
 * Options of the runtime module. `connection` and `queues` are required; every other option has a
 * default that never changes without a major release.
 */
export interface JobsModuleOptions {
  // #region Properties
  /**
   * Property connection
   *
   * @description
   * Connection of the application role. The role needs no DDL right: the schema and the queues are
   * created by `provisionJobs`.
   *
   * @type {JobsConnectionOptions}
   * @readonly
   */
  readonly connection: JobsConnectionOptions;

  /**
   * Property queues
   *
   * @description
   * The queues of the service, the same list given to `provisionJobs`. Start-up fails when one of
   * them, or its dead-letter queue, was not provisioned.
   *
   * @type {readonly JobQueueDeclaration[]}
   * @readonly
   */
  readonly queues: readonly JobQueueDeclaration[];

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
   * Property runInOrganization
   *
   * @description
   * Wraps each handler call in the organization context of its job. Defaults to calling the
   * handler directly.
   *
   * @type {RunInOrganization}
   * @readonly
   */
  readonly runInOrganization?: RunInOrganization;

  /**
   * Property shutdownTimeoutMs
   *
   * @description
   * Time running handlers get to finish from the start of shutdown, in milliseconds, at least
   * 1000. Past it, their signals are aborted and their attempts are reported. PostgreSQL still
   * settles the failed attempts and closes the pool. Defaults to 30000.
   *
   * @type {number}
   * @readonly
   */
  readonly shutdownTimeoutMs?: number;

  /**
   * Property deadLetterCheckIntervalSeconds
   *
   * @description
   * Whole seconds between checks of retained dead letters, up to 2,147,483. A non-empty
   * queue is logged as an error on each check. Defaults to 60. Set `0` to disable the watch.
   *
   * @type {number}
   * @readonly
   */
  readonly deadLetterCheckIntervalSeconds?: number;

  /**
   * Property allowPrivilegedRole
   *
   * @description
   * Lets the runtime start with a role that can create objects in the pg-boss schema. Start-up
   * refuses such a role by default, because it means the service runs as the migrator role or as
   * an owner. Meant for a local stack with a single role. Defaults to `false`.
   *
   * @type {boolean}
   * @readonly
   */
  readonly allowPrivilegedRole?: boolean;
  // #endregion
}

/**
 * Interface ResolvedJobsModuleOptions
 *
 * @description
 * Module options with every default applied and every value validated.
 */
export interface ResolvedJobsModuleOptions {
  // #region Properties
  /**
   * Property connection
   *
   * @description
   * Connection of the application role.
   *
   * @type {JobsConnectionOptions}
   * @readonly
   */
  readonly connection: JobsConnectionOptions;

  /**
   * Property queues
   *
   * @description
   * Resolved queues of the service.
   *
   * @type {readonly ResolvedJobQueue[]}
   * @readonly
   */
  readonly queues: readonly ResolvedJobQueue[];

  /**
   * Property schema
   *
   * @description
   * Schema that holds the pg-boss tables.
   *
   * @type {string}
   * @readonly
   */
  readonly schema: string;

  /**
   * Property runInOrganization
   *
   * @description
   * Wrapper applied around each handler call.
   *
   * @type {RunInOrganization}
   * @readonly
   */
  readonly runInOrganization: RunInOrganization;

  /**
   * Property shutdownTimeoutMs
   *
   * @description
   * Time running handlers get to finish at shutdown, in milliseconds.
   *
   * @type {number}
   * @readonly
   */
  readonly shutdownTimeoutMs: number;

  /**
   * Property deadLetterCheckIntervalSeconds
   *
   * @description
   * Seconds between counts of retained dead letters. `0` when the watch is off.
   *
   * @type {number}
   * @readonly
   */
  readonly deadLetterCheckIntervalSeconds: number;

  /**
   * Property allowPrivilegedRole
   *
   * @description
   * Whether a role that can create objects in the schema may run the runtime.
   *
   * @type {boolean}
   * @readonly
   */
  readonly allowPrivilegedRole: boolean;
  // #endregion
}

/**
 * Function runDirectly
 *
 * @description
 * Runs the handler when the application does not install an organization context.
 *
 * @param {string | null} _organizationId - Organization of the job, unused.
 * @param {() => Promise<void>} work - Handling of the job.
 * @returns {Promise<void>} Settles with the work.
 */
function runDirectly(_organizationId: string | null, work: () => Promise<void>): Promise<void> {
  return work();
}

/**
 * Function resolveJobsModuleOptions
 *
 * @description
 * Resolves defaults and validates the job runtime configuration before opening a connection.
 *
 * @param {JobsModuleOptions} options - Options given to `JobsModule`.
 * @returns {ResolvedJobsModuleOptions} The options with every value set.
 * @throws {Error} When an option or queue declaration is invalid.
 */
export function resolveJobsModuleOptions(options: JobsModuleOptions): ResolvedJobsModuleOptions {
  const connection: unknown = options.connection;
  assertConnection(connection);
  const schema: unknown = options.schema ?? DEFAULT_JOBS_SCHEMA;
  assertSchemaName(schema);
  const shutdownTimeoutMs: number = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1_000) {
    throw new Error('shutdownTimeoutMs must be an integer of at least 1000.');
  }
  const runInOrganization: unknown = options.runInOrganization ?? runDirectly;
  if (typeof runInOrganization !== 'function') {
    throw new Error('runInOrganization must be a function.');
  }
  const deadLetterCheckIntervalSeconds: number =
    options.deadLetterCheckIntervalSeconds ?? DEFAULT_DEAD_LETTER_CHECK_INTERVAL_SECONDS;
  if (
    !Number.isInteger(deadLetterCheckIntervalSeconds) ||
    deadLetterCheckIntervalSeconds < 0 ||
    deadLetterCheckIntervalSeconds > MAX_DEAD_LETTER_CHECK_INTERVAL_SECONDS
  ) {
    throw new Error(
      `deadLetterCheckIntervalSeconds must be an integer from 0 to ${String(MAX_DEAD_LETTER_CHECK_INTERVAL_SECONDS)}.`,
    );
  }
  const allowPrivilegedRole: unknown = options.allowPrivilegedRole ?? false;
  if (typeof allowPrivilegedRole !== 'boolean') {
    throw new Error('allowPrivilegedRole must be a boolean.');
  }
  return {
    connection,
    queues: resolveJobQueues(options.queues),
    schema,
    runInOrganization: options.runInOrganization ?? runDirectly,
    shutdownTimeoutMs,
    deadLetterCheckIntervalSeconds,
    allowPrivilegedRole,
  };
}
