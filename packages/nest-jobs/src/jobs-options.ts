import type { ConnectionOptions } from 'node:tls';

import type { FactoryProvider, ModuleMetadata } from '@nestjs/common';

import { resolveJobQueues, type JobQueueDeclaration, type ResolvedJobQueue } from './job-queue.js';

/**
 * Constant JOBS_MODULE_OPTIONS
 *
 * @description
 * Injection token of the options given to `JobsModule`. Internal to the package.
 *
 * @type {symbol}
 */
export const JOBS_MODULE_OPTIONS: unique symbol = Symbol('JOBS_MODULE_OPTIONS');

/**
 * Constant DEFAULT_JOBS_SCHEMA
 *
 * @description
 * PostgreSQL schema that holds the pg-boss tables when none is configured.
 *
 * @type {string}
 */
export const DEFAULT_JOBS_SCHEMA: string = 'pgboss';

/**
 * Constant JOBS_POOL_SIZE
 *
 * @description
 * Connections of the pool pg-boss owns, apart from the application pool. Fixed on purpose: jobs
 * must not take connections away from requests.
 *
 * @type {number}
 */
export const JOBS_POOL_SIZE: number = 2;

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
 * Seconds between two counts of the jobs that arrived in the dead-letter queues.
 *
 * @type {number}
 */
export const DEFAULT_DEAD_LETTER_CHECK_INTERVAL_SECONDS: number = 60;

/**
 * Constant RESERVED_SCHEMA_PATTERN
 *
 * @description
 * Schemas that cannot hold the pg-boss tables. `public` holds business tables in many databases,
 * and the table grants of the provisioning would widen the application role on them; the others
 * belong to PostgreSQL.
 *
 * @type {RegExp}
 */
const RESERVED_SCHEMA_PATTERN: RegExp = /^(?:public|information_schema|pg_.*)$/u;

/**
 * Constant IDENTIFIER_PATTERN
 *
 * @description
 * A PostgreSQL identifier that reads the same quoted and unquoted: lowercase letters, digits and
 * underscores, not starting with a digit. Schema and role names are restricted to it because they
 * are written into DDL and GRANT statements, where no bind parameter exists.
 *
 * @type {RegExp}
 */
const IDENTIFIER_PATTERN: RegExp = /^[a-z_][a-z0-9_]*$/u;

/**
 * Constant MAX_SCHEMA_NAME_BYTES
 *
 * @description
 * Longest schema name pg-boss accepts, in bytes.
 *
 * @type {number}
 */
const MAX_SCHEMA_NAME_BYTES: number = 50;

/**
 * Constant MAX_IDENTIFIER_BYTES
 *
 * @description
 * Longest identifier PostgreSQL stores without truncating it, in bytes.
 *
 * @type {number}
 */
const MAX_IDENTIFIER_BYTES: number = 63;

/**
 * Interface JobsConnectionOptions
 *
 * @description
 * How to reach the service's own PostgreSQL database: the migrator role for `provisionJobs`, the
 * application role for `JobsModule`.
 *
 * Give `connectionString`, or `host` with `user` and `database`: the three are required together
 * so the role and the database are never read from the `PG*` environment variables, which could
 * carry those of the other role. What is left unset (`port`, `password`, `ssl`) still follows the
 * driver: its default, then `PGPORT`, `PGPASSWORD` and `PGSSLMODE`. A connection URI is handed to
 * the driver as is; a part it does not carry falls back the same way, so write the user and the
 * database in it.
 */
export interface JobsConnectionOptions {
  // #region Properties
  /**
   * Property connectionString
   *
   * @description
   * PostgreSQL connection URI, with the user and the database in it. Never logged by this
   * package. No default.
   *
   * @type {string}
   * @readonly
   */
  readonly connectionString?: string;

  /**
   * Property host
   *
   * @description
   * Server host name, when no connection URI is given. No default.
   *
   * @type {string}
   * @readonly
   */
  readonly host?: string;

  /**
   * Property port
   *
   * @description
   * Server port. Defaults to the driver's: `PGPORT`, then 5432.
   *
   * @type {number}
   * @readonly
   */
  readonly port?: number;

  /**
   * Property database
   *
   * @description
   * Database name. Required with `host`. No default.
   *
   * @type {string}
   * @readonly
   */
  readonly database?: string;

  /**
   * Property user
   *
   * @description
   * Role to connect as. Required with `host`. No default.
   *
   * @type {string}
   * @readonly
   */
  readonly user?: string;

  /**
   * Property password
   *
   * @description
   * Password of the role. Never logged by this package. Defaults to the driver's: `PGPASSWORD`,
   * then the password file.
   *
   * @type {string}
   * @readonly
   */
  readonly password?: string;

  /**
   * Property ssl
   *
   * @description
   * TLS settings handed to the driver. Defaults to the driver's: `PGSSLMODE`, then no TLS unless
   * the connection URI asks for it.
   *
   * @type {boolean | ConnectionOptions}
   * @readonly
   */
  readonly ssl?: boolean | ConnectionOptions;
  // #endregion
}

/**
 * Type RunInOrganization
 *
 * @description
 * Wraps the handling of one job in the context of its organization, for example the organization
 * context of `@cadenway/nest-common`. It must call `work` exactly once and resolve or reject with
 * it.
 *
 * @type {(organizationId: string | null, work: () => Promise<void>) => Promise<void>}
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
   * Time running handlers get to finish at shutdown, in milliseconds, at least 1000. Past it their
   * attempts are failed, which uses one retry, and logged. Defaults to 30000.
   *
   * @type {number}
   * @readonly
   */
  readonly shutdownTimeoutMs?: number;

  /**
   * Property deadLetterCheckIntervalSeconds
   *
   * @description
   * Whole seconds between two counts of the jobs that arrived in each declared dead-letter queue.
   * Each count above zero is logged as an error, which covers the dead letters no running handler
   * can log, such as those of a crashed process. `0` disables the watch. Defaults to 60.
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
 * Interface JobsModuleAsyncOptions
 *
 * @description
 * Options of `JobsModule.forRootAsync`: the module options come from a factory that may inject
 * providers, typically the typed configuration of the service.
 */
export interface JobsModuleAsyncOptions {
  // #region Properties
  /**
   * Property imports
   *
   * @description
   * Modules that export the providers the factory injects. Defaults to none.
   *
   * @type {ModuleMetadata['imports']}
   * @readonly
   */
  readonly imports?: ModuleMetadata['imports'];

  /**
   * Property inject
   *
   * @description
   * Tokens of the providers passed to the factory, in order. Defaults to none.
   *
   * @type {FactoryProvider<JobsModuleOptions>['inject']}
   * @readonly
   */
  readonly inject?: FactoryProvider<JobsModuleOptions>['inject'];

  /**
   * Property useFactory
   *
   * @description
   * Builds the module options, synchronously or not.
   *
   * @type {FactoryProvider<JobsModuleOptions>['useFactory']}
   * @readonly
   */
  readonly useFactory: FactoryProvider<JobsModuleOptions>['useFactory'];
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
   * Seconds between two counts of the dead-letter arrivals; `0` when the watch is off.
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
 * Default `runInOrganization`: runs the work without any organization context.
 *
 * @param {string | null} _organizationId - Organization of the job, unused.
 * @param {() => Promise<void>} work - Handling of the job.
 * @returns {Promise<void>} Settles with the work.
 */
function runDirectly(_organizationId: string | null, work: () => Promise<void>): Promise<void> {
  return work();
}

/**
 * Function assertSchemaName
 *
 * @description
 * Refuses a schema name that would not read the same quoted and unquoted, that pg-boss rejects, or
 * that is not a schema of its own: `public`, `information_schema` and the `pg_` schemas.
 *
 * @param {unknown} schema - Candidate schema name.
 * @throws {Error} When the name is not a lowercase identifier of at most 50 bytes, or is reserved.
 */
export function assertSchemaName(schema: unknown): asserts schema is string {
  if (
    typeof schema !== 'string' ||
    !IDENTIFIER_PATTERN.test(schema) ||
    Buffer.byteLength(schema, 'utf8') > MAX_SCHEMA_NAME_BYTES
  ) {
    throw new Error(
      'schema must be at most 50 lowercase letters, digits or underscores and cannot start with a digit.',
    );
  }
  if (RESERVED_SCHEMA_PATTERN.test(schema)) {
    throw new Error(
      `schema must be a schema of its own: "${schema}" is reserved, and the grants on its tables would reach tables that are not pg-boss tables.`,
    );
  }
}

/**
 * Function assertRoleName
 *
 * @description
 * Refuses a role name that would not read the same quoted and unquoted. The name is written into
 * GRANT statements, where no bind parameter exists.
 *
 * @param {unknown} role - Candidate role name.
 * @throws {Error} When the name is not a lowercase identifier of at most 63 bytes.
 */
export function assertRoleName(role: unknown): asserts role is string {
  if (
    typeof role !== 'string' ||
    !IDENTIFIER_PATTERN.test(role) ||
    Buffer.byteLength(role, 'utf8') > MAX_IDENTIFIER_BYTES
  ) {
    throw new Error(
      'appRole must be at most 63 lowercase letters, digits or underscores and cannot start with a digit.',
    );
  }
}

/**
 * Function assertConnection
 *
 * @description
 * Refuses connection options that do not name the server, the role and the database, so none of
 * the three is read from the `PG*` environment variables: a container that carries the variables
 * of the migrator role would otherwise run the runtime as that role. A connection URI is not
 * parsed here; the parts it lacks, and the unset `port`, `password` and `ssl`, still follow the
 * driver's fallbacks.
 *
 * @param {unknown} connection - Candidate connection options.
 * @throws {Error} When there is no `connectionString` and `host`, `user` or `database` is missing.
 */
export function assertConnection(connection: unknown): asserts connection is JobsConnectionOptions {
  if (typeof connection !== 'object' || connection === null) {
    throw new Error('connection is required.');
  }
  const candidate: JobsConnectionOptions = connection;
  if (candidate.connectionString) {
    return;
  }
  if (!candidate.host || !candidate.user || !candidate.database) {
    throw new Error('connection needs a connectionString, or a host with a user and a database.');
  }
}

/**
 * Function resolveJobsModuleOptions
 *
 * @description
 * Applies the defaults of the module options and validates them.
 *
 * @param {JobsModuleOptions} options - Options given to `JobsModule`.
 * @returns {ResolvedJobsModuleOptions} The options with every value set.
 * @throws {Error} When an option or a queue declaration is invalid.
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
  if (!Number.isInteger(deadLetterCheckIntervalSeconds) || deadLetterCheckIntervalSeconds < 0) {
    throw new Error('deadLetterCheckIntervalSeconds must be an integer of at least 0.');
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
