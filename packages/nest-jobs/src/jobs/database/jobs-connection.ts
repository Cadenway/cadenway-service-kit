import type { ConnectionOptions } from 'node:tls';

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
