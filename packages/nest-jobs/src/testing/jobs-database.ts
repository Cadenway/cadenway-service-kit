import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client, type QueryResult, type QueryResultRow } from 'pg';

import type { JobsConnectionOptions } from '../jobs-options.js';

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
   * @returns {Promise<JobsTestDatabase>} The database and its connections.
   */
  createDatabase(ownedByMigrator?: boolean): Promise<JobsTestDatabase>;

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
    async createDatabase(ownedByMigrator: boolean = true): Promise<JobsTestDatabase> {
      created += 1;
      const name: string = `service_${String(created)}`;
      const owner: string = ownedByMigrator ? ` OWNER ${MIGRATOR_ROLE}` : '';
      await queryAs(admin, `CREATE DATABASE ${name}${owner}`);
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
