import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client, type QueryResult, type QueryResultRow } from 'pg';

import type { JobsConnectionOptions } from '../jobs/database/jobs-connection.js';

/**
 * Constant POSTGRES_IMAGE
 *
 * @description
 * PostgreSQL image of the integration tests, the tag cadenway-ops pins for the services.
 *
 * @type {string}
 */
const POSTGRES_IMAGE: string = 'postgres:18.6-alpine';

/**
 * Constant MIGRATOR_ROLE
 *
 * @description
 * Role that runs DDL in the tests, as `<service>_migrator` does in a deployment.
 *
 * @type {string}
 */
export const MIGRATOR_ROLE: string = 'svc_migrator';

/**
 * Constant APP_ROLE
 *
 * @description
 * Role the runtime connects as in the tests, as `<service>_app` does in a deployment. It owns
 * nothing and has no CREATE right on any database or schema.
 *
 * @type {string}
 */
export const APP_ROLE: string = 'svc_app';

/**
 * Interface JobsTestDatabase
 *
 * @description
 * One disposable database of the test server and the three ways to reach it.
 */
export interface JobsTestDatabase {
  // #region Properties
  /**
   * Property name
   *
   * @description
   * Name of the database.
   *
   * @type {string}
   * @readonly
   */
  readonly name: string;

  /**
   * Property admin
   *
   * @description
   * Connection of the superuser, used by the tests to arrange and to observe, never by the code
   * under test.
   *
   * @type {JobsConnectionOptions}
   * @readonly
   */
  readonly admin: JobsConnectionOptions;

  /**
   * Property migrator
   *
   * @description
   * Connection of the migrator role.
   *
   * @type {JobsConnectionOptions}
   * @readonly
   */
  readonly migrator: JobsConnectionOptions;

  /**
   * Property app
   *
   * @description
   * Connection of the application role.
   *
   * @type {JobsConnectionOptions}
   * @readonly
   */
  readonly app: JobsConnectionOptions;
  // #endregion
}

/**
 * Interface JobsTestServer
 *
 * @description
 * A disposable PostgreSQL server holding the migrator and application roles.
 */
export interface JobsTestServer {
  // #region Methods
  /**
   * Method createDatabase
   *
   * @description
   * Creates an empty database so each scenario starts from a known state.
   *
   * @param {boolean} [ownedByMigrator] - Whether the migrator role owns the database and may
   * therefore create schemas in it. Defaults to `true`.
   * @param {boolean} [opsDefaultPrivileges] - Whether the database is set up as cadenway-ops sets
   * up a service database, default privileges included. Defaults to `true`.
   * @returns {Promise<JobsTestDatabase>} The database and its connections.
   */
  createDatabase(
    ownedByMigrator?: boolean,
    opsDefaultPrivileges?: boolean,
  ): Promise<JobsTestDatabase>;

  /**
   * Method stop
   *
   * @description
   * Stops and removes the container.
   *
   * @returns {Promise<void>} Resolves once the container is gone.
   */
  stop(): Promise<void>;
  // #endregion
}

/**
 * Function queryAs
 *
 * @description
 * Runs one statement on a short-lived connection and returns its result.
 *
 * @param {JobsConnectionOptions} connection - Role and database to connect with.
 * @param {string} text - SQL text.
 * @param {unknown[]} [values] - Values bound to the placeholders.
 * @returns {Promise<QueryResult<TRow>>} The result of the statement.
 */
export async function queryAs<TRow extends QueryResultRow>(
  connection: JobsConnectionOptions,
  text: string,
  values?: unknown[],
): Promise<QueryResult<TRow>> {
  const client: Client = new Client({ ...connection });
  await client.connect();
  try {
    return await client.query<TRow>(text, values);
  } finally {
    await client.end();
  }
}

/**
 * Function waitFor
 *
 * @description
 * Polls a condition until it holds, for assertions on what a background worker eventually does.
 *
 * @param {() => Promise<boolean> | boolean} condition - Condition to wait for.
 * @param {number} timeoutMs - Longest wait, in milliseconds.
 * @returns {Promise<void>} Resolves once the condition holds.
 * @throws {Error} When the condition still fails after the timeout.
 */
export async function waitFor(
  condition: () => Promise<boolean> | boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline: number = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error(`The condition did not hold within ${String(timeoutMs)} ms.`);
    }
    await sleep(100);
  }
}

/**
 * Constant PG_BOSS_SCHEMA_LOCK
 *
 * @description
 * SQL expression of the advisory lock pg-boss 12.38.2 takes around the installation and every
 * migration of the `pgboss` schema (`advisoryLockKey` in its plans). Holding it stops a
 * provisioning run right before pg-boss installs or migrates.
 *
 * @type {string}
 */
export const PG_BOSS_SCHEMA_LOCK: string =
  "('x' || encode(sha224((current_database() || '.pgboss.pgboss')::bytea), 'hex'))::bit(64)::bigint";

/**
 * Constant PROVISIONING_LOCK
 *
 * @description
 * SQL expression of the advisory lock every provisioning transaction of the `pgboss` schema takes.
 * Holding it stops a provisioning run at its next transaction.
 *
 * @type {string}
 */
export const PROVISIONING_LOCK: string =
  "pg_catalog.hashtextextended('cadenway.nest-jobs.provision.pgboss', 0)";

/**
 * Interface HeldLock
 *
 * @description
 * A session-level advisory lock held by a test.
 */
export interface HeldLock {
  // #region Methods
  /**
   * Method release
   *
   * @description
   * Releases the lock and closes its session.
   *
   * @returns {Promise<void>} Resolves once the session is closed.
   */
  release(): Promise<void>;
  // #endregion
}

/**
 * Function holdAdvisoryLock
 *
 * @description
 * Takes a session-level advisory lock on a session of its own and keeps it until released,
 * waiting for whoever holds it first.
 *
 * @param {JobsConnectionOptions} connection - Role and database to lock in.
 * @param {string} key - SQL expression of the lock key.
 * @returns {Promise<HeldLock>} The held lock.
 */
export async function holdAdvisoryLock(
  connection: JobsConnectionOptions,
  key: string,
): Promise<HeldLock> {
  const client: Client = new Client({ ...connection });
  await client.connect();
  await client.query(`SELECT pg_catalog.pg_advisory_lock(${key})`);
  return {
    async release(): Promise<void> {
      try {
        await client.query(`SELECT pg_catalog.pg_advisory_unlock(${key})`);
      } finally {
        await client.end();
      }
    },
  };
}

/**
 * Function waitForAdvisoryWaiter
 *
 * @description
 * Waits until a session of a role waits for an advisory lock, which tells a test that the run it
 * started has reached the step the lock guards.
 *
 * @param {JobsTestDatabase} database - Database the session is connected to.
 * @param {string} role - Role of the waiting session.
 * @returns {Promise<void>} Resolves once such a session waits.
 */
export async function waitForAdvisoryWaiter(
  database: JobsTestDatabase,
  role: string,
): Promise<void> {
  await waitFor(async (): Promise<boolean> => {
    const waiting: QueryResult<{ count: number }> = await queryAs<{ count: number }>(
      database.admin,
      `SELECT count(*)::int AS count
       FROM pg_catalog.pg_locks l
       JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
       WHERE l.locktype = 'advisory' AND NOT l.granted AND a.datname = $1 AND a.usename = $2`,
      [database.name, role],
    );
    return (waiting.rows[0]?.count ?? 0) > 0;
  }, 20_000);
}

/**
 * Function opsServiceDatabaseStatements
 *
 * @description
 * The statements cadenway-ops runs in a service database once its two roles exist
 * (`compose/postgres/init/10-service-databases.sh`), run here as the superuser. The default
 * privileges are the part that matters to the jobs: every schema, table and sequence the migrator
 * role creates is opened to the application role at once, pg-boss objects included.
 *
 * @param {string} database - Name of the service database.
 * @returns {readonly string[]} Statements, in execution order.
 */
function opsServiceDatabaseStatements(database: string): readonly string[] {
  return [
    `REVOKE ALL ON DATABASE ${database} FROM PUBLIC`,
    `REVOKE ALL ON DATABASE ${database} FROM ${APP_ROLE}`,
    `GRANT CONNECT ON DATABASE ${database} TO ${APP_ROLE}`,
    // The migrator owns its database in cadenway-ops; the tests that make another role the owner
    // keep it able to connect.
    `GRANT CONNECT ON DATABASE ${database} TO ${MIGRATOR_ROLE}`,
    'REVOKE CREATE ON SCHEMA public FROM PUBLIC',
    `GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_ROLE} GRANT USAGE ON SCHEMAS TO ${APP_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_ROLE} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_ROLE} GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE}`,
  ];
}

/**
 * Function startJobsTestServer
 *
 * @description
 * Starts a disposable PostgreSQL container and creates the two roles of a service in it, with
 * passwords generated for the run.
 *
 * @returns {Promise<JobsTestServer>} The running server.
 */
export async function startJobsTestServer(): Promise<JobsTestServer> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withPassword(randomBytes(12).toString('hex'))
    .start();
  const host: string = container.getHost();
  const port: number = container.getPort();
  const admin: JobsConnectionOptions = {
    host,
    port,
    database: container.getDatabase(),
    user: container.getUsername(),
    password: container.getPassword(),
  };
  const migratorPassword: string = randomBytes(12).toString('hex');
  const appPassword: string = randomBytes(12).toString('hex');
  await queryAs(admin, `CREATE ROLE ${MIGRATOR_ROLE} LOGIN PASSWORD '${migratorPassword}'`);
  await queryAs(admin, `CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${appPassword}'`);
  let created: number = 0;

  return {
    async createDatabase(
      ownedByMigrator: boolean = true,
      opsDefaultPrivileges: boolean = true,
    ): Promise<JobsTestDatabase> {
      created += 1;
      const name: string = `service_${String(created)}`;
      const owner: string = ownedByMigrator ? ` OWNER ${MIGRATOR_ROLE}` : '';
      await queryAs(admin, `CREATE DATABASE ${name}${owner}`);
      if (opsDefaultPrivileges) {
        for (const statement of opsServiceDatabaseStatements(name)) {
          await queryAs({ ...admin, database: name }, statement);
        }
      }
      return {
        name,
        admin: { ...admin, database: name },
        migrator: { host, port, database: name, user: MIGRATOR_ROLE, password: migratorPassword },
        app: { host, port, database: name, user: APP_ROLE, password: appPassword },
      };
    },
    async stop(): Promise<void> {
      await container.stop();
    },
  };
}
