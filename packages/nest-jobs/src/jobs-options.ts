import type { ConnectionOptions } from 'node:tls';

import type { FactoryProvider, ModuleMetadata } from '@nestjs/common';
import type { ConstructorOptions } from 'pg-boss';

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
 * How to reach the service's own PostgreSQL database. Give `connectionString`, or `host` with the
 * other fields; one of the two is required so the connection never falls back silently on the
 * `PG*` environment variables. The role is the migrator role for `provisionJobs` and the
 * application role for `JobsModule`.
 */
export interface JobsConnectionOptions {
  // #region Properties
  /**
   * Property connectionString
   *
   * @description
   * PostgreSQL connection URI. Never logged by this package.
   *
   * @type {string}
   * @readonly
   */
  readonly connectionString?: string;

  /**
   * Property host
   *
   * @description
   * Server host name, when no connection URI is given.
   *
   * @type {string}
   * @readonly
   */
  readonly host?: string;

  /**
   * Property port
   *
   * @description
   * Server port. Defaults to the driver's default, 5432.
   *
   * @type {number}
   * @readonly
   */
  readonly port?: number;

  /**
   * Property database
   *
   * @description
   * Database name.
   *
   * @type {string}
   * @readonly
   */
  readonly database?: string;

  /**
   * Property user
   *
   * @description
   * Role to connect as.
   *
   * @type {string}
   * @readonly
   */
  readonly user?: string;

  /**
   * Property password
   *
   * @description
   * Password of the role. Never logged by this package.
   *
   * @type {string}
   * @readonly
   */
  readonly password?: string;

  /**
   * Property ssl
   *
   * @description
   * TLS settings handed to the driver. Defaults to the driver's default, no TLS unless the
   * connection URI asks for it.
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
   * attempts are failed and retried later. Defaults to 30000.
   *
   * @type {number}
   * @readonly
   */
  readonly shutdownTimeoutMs?: number;
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
 * Refuses a schema name that would not read the same quoted and unquoted, or that pg-boss rejects.
 *
 * @param {unknown} schema - Candidate schema name.
 * @throws {Error} When the name is not a lowercase identifier of at most 50 bytes.
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
 * Refuses connection options that name no server, so the driver never falls back silently on the
 * `PG*` environment variables or on localhost.
 *
 * @param {unknown} connection - Candidate connection options.
 * @throws {Error} When neither `connectionString` nor `host` is set.
 */
export function assertConnection(connection: unknown): asserts connection is JobsConnectionOptions {
  if (typeof connection !== 'object' || connection === null) {
    throw new Error('connection is required.');
  }
  const candidate: JobsConnectionOptions = connection;
  if (!candidate.connectionString && !candidate.host) {
    throw new Error('connection needs a connectionString or a host.');
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
  return {
    connection,
    queues: resolveJobQueues(options.queues),
    schema,
    runInOrganization: options.runInOrganization ?? runDirectly,
    shutdownTimeoutMs,
  };
}

/**
 * Function toRuntimeBossOptions
 *
 * @description
 * Builds the pg-boss options of the runtime, the application role.
 *
 * The runtime never runs DDL: `migrate` and `createSchema` are off, so start-up only checks the
 * installed schema version, and `reindex` is off because rebuilding an index needs its ownership.
 * Queue statistics and warnings are not persisted, which keeps maintenance to plain DML. The fixed
 * values are written after the connection so a connection object cannot override them.
 *
 * @param {ResolvedJobsModuleOptions} options - Resolved module options.
 * @returns {ConstructorOptions} Options for the pg-boss constructor.
 */
export function toRuntimeBossOptions(options: ResolvedJobsModuleOptions): ConstructorOptions {
  return {
    ...options.connection,
    schema: options.schema,
    max: JOBS_POOL_SIZE,
    migrate: false,
    createSchema: false,
    supervise: true,
    schedule: true,
    reindex: false,
    persistQueueStats: false,
    persistWarnings: false,
  };
}
