import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import pg from 'pg';

/**
 * Constant POSTGRES_IMAGE
 *
 * @description
 * PostgreSQL image of the integration specs: the tag cadenway-ops pins in `compose/infra.yaml`.
 * PostgreSQL 18 is required for `uuidv7()`.
 *
 * @type {string}
 */
export const POSTGRES_IMAGE: string = 'postgres:18.6-alpine';

/**
 * Interface TestDatabase
 *
 * @description
 * Disposable PostgreSQL with the two roles of a Cadenway service.
 */
export interface TestDatabase {
  // #region Properties
  /**
   * Property appUrl
   *
   * @description
   * Connection string of the application role: no DDL rights, subject to row-level security.
   *
   * @type {string}
   * @readonly
   */
  readonly appUrl: string;

  /**
   * Property migrator
   *
   * @description
   * Pool of the migrator role, which owns the tables.
   *
   * @type {pg.Pool}
   * @readonly
   */
  readonly migrator: pg.Pool;

  /**
   * Property admin
   *
   * @description
   * Pool of the superuser, to inspect or alter rows whatever the policies say.
   *
   * @type {pg.Pool}
   * @readonly
   */
  readonly admin: pg.Pool;
  // #endregion

  // #region Methods
  /**
   * Method migrate
   *
   * @description
   * Runs DDL as the migrator, then forces row-level security on the named tables and grants the
   * application role its data rights, as a service migration does.
   *
   * @param {readonly string[]} statements - DDL statements to run in order.
   * @param {readonly string[]} forcedTables - Tables to force row-level security on.
   * @returns {Promise<void>} Resolves once migrated.
   */
  migrate(statements: readonly string[], forcedTables: readonly string[]): Promise<void>;

  /**
   * Method stop
   *
   * @description
   * Closes the pools and removes the container.
   *
   * @returns {Promise<void>} Resolves once stopped.
   */
  stop(): Promise<void>;
  // #endregion
}

/**
 * Function kitMigration
 *
 * @description
 * Generates, with drizzle-kit itself, the statements that create the given Drizzle tables in an
 * empty database: what `drizzle-kit generate` writes in a service that declares them.
 *
 * @param {Record<string, unknown>} schema - Drizzle tables, by export name.
 * @returns {Promise<string[]>} The DDL statements.
 */
export async function kitMigration(schema: Record<string, unknown>): Promise<string[]> {
  return generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema));
}

/**
 * Function startTestDatabase
 *
 * @description
 * Starts a disposable PostgreSQL and creates the migrator and application roles the way
 * cadenway-ops does: the migrator may create objects, the application role may not, is not a
 * superuser and does not bypass row-level security.
 *
 * @returns {Promise<TestDatabase>} The running database.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    POSTGRES_IMAGE,
  ).start();
  const database: string = container.getDatabase();
  const address: string = `${container.getHost()}:${String(container.getPort())}/${database}`;
  const admin: pg.Pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 });
  await admin.query(`
    create role svc_migrator login password 'migrator';
    create role svc_app login password 'app';
    grant create on database "${database}" to svc_migrator;
    grant usage, create on schema public to svc_migrator;
    grant usage on schema public to svc_app;
  `);
  const migrator: pg.Pool = new pg.Pool({
    connectionString: `postgres://svc_migrator:migrator@${address}`,
    max: 2,
  });
  return {
    appUrl: `postgres://svc_app:app@${address}`,
    migrator,
    admin,
    migrate: async (
      statements: readonly string[],
      forcedTables: readonly string[],
    ): Promise<void> => {
      for (const statement of statements) {
        await migrator.query(statement);
      }
      for (const table of forcedTables) {
        await migrator.query(`alter table "${table}" force row level security`);
      }
      await migrator.query(
        'grant select, insert, update, delete on all tables in schema public to svc_app',
      );
    },
    stop: async (): Promise<void> => {
      await migrator.end();
      await admin.end();
      await container.stop();
    },
  };
}
