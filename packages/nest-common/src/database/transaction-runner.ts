import { AsyncLocalStorage } from 'node:async_hooks';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';

import { requireOrganizationId } from '../auth/organization-context.js';
import { ORGANIZATION_SETTING, SYSTEM_ACCESS_SETTING } from './organization-policy.js';

/**
 * Type DatabaseSchema
 *
 * @description
 * Drizzle schema object of a service: its tables and relations, by export name.
 *
 * @type {Record<string, unknown>}
 */
export type DatabaseSchema = Record<string, unknown>;

/**
 * Type TransactionKind
 *
 * @description
 * Which runner opened a transaction.
 *
 * @type {'tenant' | 'system'}
 */
export type TransactionKind = 'tenant' | 'system';

/**
 * Interface TransactionClient
 *
 * @description
 * Raw SQL access to the connection of a transaction, for libraries that take an executor, such
 * as the job queue. It cannot commit, roll back or release the connection.
 */
export interface TransactionClient {
  // #region Methods
  /**
   * Method query
   *
   * @description
   * Runs one parameterized statement inside the transaction.
   *
   * @param {string} text - SQL text with `$1`-style placeholders.
   * @param {unknown[]} values - Values of the placeholders.
   * @returns {Promise<{ rows: unknown[] }>} The rows returned by the statement.
   */
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  // #endregion
}

/**
 * Interface TransactionScope
 *
 * @description
 * What the work of a transaction receives: everything bound to one connection and one
 * transaction. Build repositories and outbox writers from it; never keep it after the work
 * returns.
 */
export interface TransactionScope<TSchema extends DatabaseSchema = Record<string, never>> {
  // #region Properties
  /**
   * Property db
   *
   * @description
   * Drizzle database bound to the connection of the transaction.
   *
   * @type {NodePgDatabase<TSchema>}
   * @readonly
   */
  readonly db: NodePgDatabase<TSchema>;

  /**
   * Property client
   *
   * @description
   * Raw SQL access to the same connection.
   *
   * @type {TransactionClient}
   * @readonly
   */
  readonly client: TransactionClient;

  /**
   * Property kind
   *
   * @description
   * Runner that opened the transaction.
   *
   * @type {TransactionKind}
   * @readonly
   */
  readonly kind: TransactionKind;

  /**
   * Property organizationId
   *
   * @description
   * Organization of a tenant transaction; `null` in a system transaction.
   *
   * @type {string | null}
   * @readonly
   */
  readonly organizationId: string | null;
  // #endregion
}

/**
 * Interface TransactionOptions
 *
 * @description
 * Options of one transaction.
 */
export interface TransactionOptions {
  // #region Properties
  /**
   * Property isolationLevel
   *
   * @description
   * Isolation level. Defaults to the PostgreSQL default, `read committed`.
   *
   * @type {'read committed' | 'repeatable read' | 'serializable' | undefined}
   * @readonly
   */
  readonly isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';

  /**
   * Property readOnly
   *
   * @description
   * Opens a read-only transaction. Defaults to `false`.
   *
   * @type {boolean | undefined}
   * @readonly
   */
  readonly readOnly?: boolean;
  // #endregion
}

/**
 * Constant UUID_PATTERN
 *
 * @description
 * Shape of an organization id. The policies cast the parameter to `uuid`: anything else would
 * fail inside PostgreSQL, far from its cause.
 *
 * @type {RegExp}
 */
const UUID_PATTERN: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Constant activeTransaction
 *
 * @description
 * Transaction the current asynchronous work runs in, so a nested `run` joins it instead of
 * opening a second connection.
 *
 * @type {AsyncLocalStorage<TransactionScope<DatabaseSchema>>}
 */
const activeTransaction: AsyncLocalStorage<TransactionScope<DatabaseSchema>> =
  new AsyncLocalStorage<TransactionScope<DatabaseSchema>>();

/**
 * Constant databases
 *
 * @description
 * Drizzle database of each pooled connection, built once per connection.
 *
 * @type {WeakMap<PoolClient, NodePgDatabase<DatabaseSchema>>}
 */
const databases: WeakMap<PoolClient, NodePgDatabase<DatabaseSchema>> = new WeakMap<
  PoolClient,
  NodePgDatabase<DatabaseSchema>
>();

/**
 * Function getActiveTransaction
 *
 * @description
 * Returns the transaction the current work runs in.
 *
 * @returns {TransactionScope<DatabaseSchema> | undefined} The scope, or `undefined` outside a transaction.
 */
export function getActiveTransaction(): TransactionScope<DatabaseSchema> | undefined {
  return activeTransaction.getStore();
}

/**
 * Function runTransaction
 *
 * @description
 * Opens a transaction on a pooled connection, sets the two access parameters with `SET LOCAL`
 * semantics, runs the work, then commits; any error rolls back and is thrown again. A connection
 * whose rollback fails is discarded instead of returning to the pool.
 *
 * @param {Pool} pool - Connection pool of the service.
 * @param {TSchema | undefined} schema - Drizzle schema of the service.
 * @param {TransactionKind} kind - Runner opening the transaction.
 * @param {string | null} organizationId - Organization of a tenant transaction.
 * @param {(scope: TransactionScope<TSchema>) => Promise<TResult>} work - Work to run inside the transaction.
 * @param {TransactionOptions} options - Isolation level and read-only flag.
 * @returns {Promise<TResult>} What the work returns, once committed.
 */
async function runTransaction<TSchema extends DatabaseSchema, TResult>(
  pool: Pool,
  schema: TSchema | undefined,
  kind: TransactionKind,
  organizationId: string | null,
  work: (scope: TransactionScope<TSchema>) => Promise<TResult>,
  options: TransactionOptions,
): Promise<TResult> {
  const connection: PoolClient = await pool.connect();
  let broken: boolean = false;
  try {
    const mode: string =
      (options.isolationLevel === undefined
        ? ''
        : ` ISOLATION LEVEL ${options.isolationLevel.toUpperCase()}`) +
      (options.readOnly === true ? ' READ ONLY' : '');
    await connection.query(`BEGIN${mode}`);
    await connection.query('select set_config($1, $2, true), set_config($3, $4, true)', [
      ORGANIZATION_SETTING,
      organizationId ?? '',
      SYSTEM_ACCESS_SETTING,
      kind === 'system' ? 'on' : 'off',
    ]);
    let db: NodePgDatabase<DatabaseSchema> | undefined = databases.get(connection);
    if (db === undefined) {
      db = schema === undefined ? drizzle(connection) : drizzle(connection, { schema });
      databases.set(connection, db);
    }
    const scope: TransactionScope<TSchema> = Object.freeze({
      db: db as unknown as NodePgDatabase<TSchema>,
      client: {
        query: (text: string, values?: unknown[]): Promise<{ rows: unknown[] }> =>
          connection.query(text, values),
      },
      kind,
      organizationId,
    });
    const result: TResult = await activeTransaction.run(scope, () => work(scope));
    await connection.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await connection.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    connection.release(broken);
  }
}

/**
 * Class TenantTransactionRunner
 *
 * @description
 * Runs the transaction of a use case that acts for one organization.
 *
 * The organization is read from the organization context, which comes from the verified internal
 * token, never from an argument. When the transaction starts the runner issues the equivalent of
 * `SET LOCAL app.organization_id`, so the row-level security policies only let that
 * organization's rows through: the second barrier behind the explicit `organization_id` filter
 * of every query. The parameter ends with the transaction.
 *
 * A `run` called inside a tenant transaction of the same organization joins it: the work shares
 * the connection and commits or rolls back with the outer one.
 */
export class TenantTransactionRunner<TSchema extends DatabaseSchema = Record<string, never>> {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Stores the pool and the schema. `DatabaseModule` builds the runner.
   *
   * @param {Pool} pool - Connection pool of the service.
   * @param {TSchema | undefined} schema - Drizzle schema of the service.
   * @constructor
   */
  public constructor(
    private readonly pool: Pool,
    private readonly schema?: TSchema,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Method run
   *
   * @description
   * Runs work in a transaction scoped to the organization of the current context.
   *
   * @param {(scope: TransactionScope<TSchema>) => Promise<TResult>} work - Work to run; it commits when it resolves and rolls back when it rejects.
   * @param {TransactionOptions} options - Isolation level and read-only flag; ignored when joining a transaction.
   * @returns {Promise<TResult>} What the work returns, once committed.
   * @throws {Error} When there is no organization in the context, its id is not a UUID, or the current transaction is a system one or belongs to another organization.
   */
  public async run<TResult>(
    work: (scope: TransactionScope<TSchema>) => Promise<TResult>,
    options: TransactionOptions = {},
  ): Promise<TResult> {
    const organizationId: string = requireOrganizationId();
    if (!UUID_PATTERN.test(organizationId)) {
      throw new Error('The organization id of the context is not a UUID.');
    }
    const active: TransactionScope<DatabaseSchema> | undefined = getActiveTransaction();
    if (active !== undefined) {
      if (active.kind !== 'tenant' || active.organizationId !== organizationId) {
        throw new Error(
          'A tenant transaction cannot start inside a system transaction or one of another organization.',
        );
      }
      return work(active as unknown as TransactionScope<TSchema>);
    }
    return runTransaction(this.pool, this.schema, 'tenant', organizationId, work, options);
  }
  // #endregion
}

/**
 * Class SystemTransactionRunner
 *
 * @description
 * Runs the transaction of work that crosses organizations or belongs to none: the outbox relay,
 * schedules that claim due rows, handlers of events without an organization, routes with an
 * anonymous or system subject.
 *
 * When the transaction starts the runner issues the equivalent of
 * `SET LOCAL app.system_access = 'on'`, which the row-level security policies accept in place of
 * an organization. Nothing filters for the caller any more: every query of a system transaction
 * names the rows it means. Never use it to serve the request of a user.
 *
 * A `run` called inside a system transaction joins it.
 */
export class SystemTransactionRunner<TSchema extends DatabaseSchema = Record<string, never>> {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Stores the pool and the schema. `DatabaseModule` builds the runner.
   *
   * @param {Pool} pool - Connection pool of the service.
   * @param {TSchema | undefined} schema - Drizzle schema of the service.
   * @constructor
   */
  public constructor(
    private readonly pool: Pool,
    private readonly schema?: TSchema,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Method run
   *
   * @description
   * Runs work in a transaction allowed to cross organizations.
   *
   * @param {(scope: TransactionScope<TSchema>) => Promise<TResult>} work - Work to run; it commits when it resolves and rolls back when it rejects.
   * @param {TransactionOptions} options - Isolation level and read-only flag; ignored when joining a transaction.
   * @returns {Promise<TResult>} What the work returns, once committed.
   * @throws {Error} When the current transaction is a tenant one: a use case never widens its own access.
   */
  public async run<TResult>(
    work: (scope: TransactionScope<TSchema>) => Promise<TResult>,
    options: TransactionOptions = {},
  ): Promise<TResult> {
    const active: TransactionScope<DatabaseSchema> | undefined = getActiveTransaction();
    if (active !== undefined) {
      if (active.kind !== 'system') {
        throw new Error('A system transaction cannot start inside a tenant transaction.');
      }
      return work(active as unknown as TransactionScope<TSchema>);
    }
    return runTransaction(this.pool, this.schema, 'system', null, work, options);
  }
  // #endregion
}
