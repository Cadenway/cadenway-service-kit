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
 * Type TransactionDatabase
 *
 * @description
 * Drizzle database handed to the work of a transaction: every query builder, without
 * `transaction`. Type the constructor of a repository with it.
 *
 * @type {Omit<NodePgDatabase<TSchema>, 'transaction'>}
 */
export type TransactionDatabase<TSchema extends DatabaseSchema = Record<string, never>> = Omit<
  NodePgDatabase<TSchema>,
  'transaction'
>;

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
   * Drizzle database bound to the connection of the transaction. It has no `transaction`
   * method: on a single connection Drizzle would issue its own `BEGIN` and `COMMIT` and end the
   * transaction of the runner early.
   *
   * @type {TransactionDatabase<TSchema>}
   * @readonly
   */
  readonly db: TransactionDatabase<TSchema>;

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
 * Class TransactionAbortedError
 *
 * @description
 * Raised when the work of a transaction resolved but PostgreSQL rolled the transaction back at
 * `COMMIT`: a statement had failed inside it and the work swallowed the error. Nothing was
 * written, so the runner refuses to report a success.
 */
export class TransactionAbortedError extends Error {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Builds the error.
   *
   * @constructor
   */
  public constructor() {
    super(
      'The transaction was rolled back at commit: a statement failed inside it and its error was not propagated.',
    );
    this.name = 'TransactionAbortedError';
  }
  // #endregion
}

/**
 * Interface ActiveTransaction
 *
 * @description
 * Transaction the current asynchronous work runs in, with what a nested `run` must check before
 * joining it.
 */
interface ActiveTransaction {
  // #region Properties
  /**
   * Property scope
   *
   * @description
   * Scope handed to the work.
   *
   * @type {TransactionScope<DatabaseSchema>}
   * @readonly
   */
  readonly scope: TransactionScope<DatabaseSchema>;

  /**
   * Property options
   *
   * @description
   * Options the transaction was opened with.
   *
   * @type {TransactionOptions}
   * @readonly
   */
  readonly options: TransactionOptions;

  /**
   * Property open
   *
   * @description
   * Whether the transaction is still running. Cleared when it commits or rolls back.
   *
   * @type {boolean}
   */
  open: boolean;
  // #endregion
}

/**
 * Class GuardedConnection
 *
 * @description
 * What Drizzle is given in place of the pooled connection: it forwards queries only while a
 * transaction of the runner is open on that connection. A query sent through a scope kept after
 * its transaction, while the connection sits in the pool, is refused instead of running outside
 * any transaction.
 */
class GuardedConnection {
  // #region Properties
  /**
   * Property open
   *
   * @description
   * Whether a transaction of the runner is open on the connection.
   *
   * @type {boolean}
   */
  public open: boolean = false;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Wraps one pooled connection.
   *
   * @param {PoolClient} connection - Pooled connection the queries are forwarded to.
   * @constructor
   */
  public constructor(private readonly connection: PoolClient) {}
  // #endregion

  // #region Methods
  /**
   * Method query
   *
   * @description
   * Forwards a query to the connection, in whatever form the caller uses.
   *
   * @param {unknown[]} parameters - Arguments of `pg`'s `query`.
   * @returns {Promise<unknown>} The result of the query.
   */
  public query(...parameters: unknown[]): Promise<unknown> {
    if (!this.open) {
      return Promise.reject(new Error(CLOSED_SCOPE_MESSAGE));
    }
    return (this.connection.query as (...forwarded: unknown[]) => Promise<unknown>)(...parameters);
  }
  // #endregion
}

/**
 * Interface ConnectionDatabase
 *
 * @description
 * Drizzle database of one pooled connection, with the guard that opens and closes it.
 */
interface ConnectionDatabase {
  // #region Properties
  /**
   * Property db
   *
   * @description
   * Drizzle database bound to the guarded connection.
   *
   * @type {NodePgDatabase<DatabaseSchema>}
   * @readonly
   */
  readonly db: NodePgDatabase<DatabaseSchema>;

  /**
   * Property guard
   *
   * @description
   * Guard between Drizzle and the connection.
   *
   * @type {GuardedConnection}
   * @readonly
   */
  readonly guard: GuardedConnection;
  // #endregion
}

/**
 * Constant CLOSED_SCOPE_MESSAGE
 *
 * @description
 * Error text of a query sent through the scope of a finished transaction.
 *
 * @type {string}
 */
const CLOSED_SCOPE_MESSAGE: string =
  'This transaction is over: its scope cannot be used any more. Do not keep a scope after its work returns.';

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
 * Constant BEGIN_STATEMENTS
 *
 * @description
 * Opening statement of each isolation level, written out so no text of an option reaches SQL.
 *
 * @type {Readonly<Record<'default' | NonNullable<TransactionOptions['isolationLevel']>, string>>}
 */
const BEGIN_STATEMENTS: Readonly<
  Record<'default' | NonNullable<TransactionOptions['isolationLevel']>, string>
> = {
  default: 'BEGIN',
  'read committed': 'BEGIN ISOLATION LEVEL READ COMMITTED',
  'repeatable read': 'BEGIN ISOLATION LEVEL REPEATABLE READ',
  serializable: 'BEGIN ISOLATION LEVEL SERIALIZABLE',
};

/**
 * Constant ISOLATION_RANK
 *
 * @description
 * Strictness of each isolation level, to compare what a nested `run` asks with what the
 * transaction it joins provides.
 *
 * @type {Readonly<Record<'default' | NonNullable<TransactionOptions['isolationLevel']>, number>>}
 */
const ISOLATION_RANK: Readonly<
  Record<'default' | NonNullable<TransactionOptions['isolationLevel']>, number>
> = { default: 0, 'read committed': 0, 'repeatable read': 1, serializable: 2 };

/**
 * Constant activeTransaction
 *
 * @description
 * Transaction the current asynchronous work runs in, so a nested `run` joins it instead of
 * opening a second connection.
 *
 * @type {AsyncLocalStorage<ActiveTransaction>}
 */
const activeTransaction: AsyncLocalStorage<ActiveTransaction> =
  new AsyncLocalStorage<ActiveTransaction>();

/**
 * Constant databases
 *
 * @description
 * Drizzle database of each pooled connection, built once per connection.
 *
 * @type {WeakMap<PoolClient, ConnectionDatabase>}
 */
const databases: WeakMap<PoolClient, ConnectionDatabase> = new WeakMap<
  PoolClient,
  ConnectionDatabase
>();

/**
 * Function openTransaction
 *
 * @description
 * Returns the transaction the current work runs in, when it is still open. A finished
 * transaction that asynchronous work outlived counts as none.
 *
 * @returns {ActiveTransaction | undefined} The running transaction, or `undefined`.
 */
function openTransaction(): ActiveTransaction | undefined {
  const active: ActiveTransaction | undefined = activeTransaction.getStore();
  return active?.open === true ? active : undefined;
}

/**
 * Function getActiveTransaction
 *
 * @description
 * Returns the scope of the transaction the current work runs in.
 *
 * @returns {TransactionScope<DatabaseSchema> | undefined} The scope, or `undefined` outside a running transaction.
 */
export function getActiveTransaction(): TransactionScope<DatabaseSchema> | undefined {
  return openTransaction()?.scope;
}

/**
 * Function assertJoinable
 *
 * @description
 * Checks that the transaction a nested `run` is about to join gives what that `run` asked for.
 * A stricter isolation level cannot be granted after the fact: silently dropping it would void
 * the guarantee the use case relies on.
 *
 * @param {ActiveTransaction} active - Transaction about to be joined.
 * @param {TransactionOptions} requested - Options of the nested `run`.
 * @returns {void}
 * @throws {Error} When the nested `run` asks for a stricter isolation level than the running transaction has.
 */
function assertJoinable(active: ActiveTransaction, requested: TransactionOptions): void {
  if (
    ISOLATION_RANK[requested.isolationLevel ?? 'default'] >
    ISOLATION_RANK[active.options.isolationLevel ?? 'default']
  ) {
    throw new Error(
      `The running transaction cannot provide the ${requested.isolationLevel ?? 'default'} isolation level: open the outer transaction with it.`,
    );
  }
}

/**
 * Function databaseOf
 *
 * @description
 * Returns the Drizzle database of a pooled connection, building it on first use. Its
 * `transaction` method is replaced: Drizzle would otherwise commit the transaction of the
 * runner.
 *
 * @param {PoolClient} connection - Pooled connection.
 * @param {DatabaseSchema | undefined} schema - Drizzle schema of the service.
 * @returns {ConnectionDatabase} The database and its guard.
 */
function databaseOf(
  connection: PoolClient,
  schema: DatabaseSchema | undefined,
): ConnectionDatabase {
  const existing: ConnectionDatabase | undefined = databases.get(connection);
  if (existing !== undefined) {
    return existing;
  }
  const guard: GuardedConnection = new GuardedConnection(connection);
  const client: PoolClient = guard as unknown as PoolClient;
  const db: NodePgDatabase<DatabaseSchema> =
    schema === undefined ? drizzle(client) : drizzle(client, { schema });
  Object.defineProperty(db, 'transaction', {
    value: (): Promise<never> =>
      Promise.reject(
        new Error('Nested Drizzle transactions are not available: use the transaction runner.'),
      ),
  });
  const created: ConnectionDatabase = { db, guard };
  databases.set(connection, created);
  return created;
}

/**
 * Function runTransaction
 *
 * @description
 * Opens a transaction on a pooled connection, sets the two access parameters with `SET LOCAL`
 * semantics, runs the work, then commits; any error rolls back and is thrown again.
 *
 * Failure handling: a connection lost while the transaction is open is recorded instead of
 * crashing the process, and the connection is discarded; a connection whose rollback fails is
 * discarded too; a `COMMIT` that PostgreSQL answers with a rollback throws.
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
  const database: ConnectionDatabase = databaseOf(connection, schema);
  let broken: boolean = false;
  // The pool removes its own listener while a connection is checked out: without one here, a
  // PostgreSQL restart during a transaction would be an uncaught exception.
  const onConnectionError: () => void = (): void => {
    broken = true;
  };
  connection.on('error', onConnectionError);
  let active: ActiveTransaction | undefined;
  try {
    await connection.query(
      BEGIN_STATEMENTS[options.isolationLevel ?? 'default'] +
        (options.readOnly === true ? ' READ ONLY' : ''),
    );
    await connection.query('select set_config($1, $2, true), set_config($3, $4, true)', [
      ORGANIZATION_SETTING,
      organizationId ?? '',
      SYSTEM_ACCESS_SETTING,
      kind === 'system' ? 'on' : 'off',
    ]);
    const current: ActiveTransaction = {
      scope: Object.freeze({
        db: database.db,
        client: {
          query: (text: string, values?: unknown[]): Promise<{ rows: unknown[] }> =>
            current.open
              ? connection.query(text, values)
              : Promise.reject(new Error(CLOSED_SCOPE_MESSAGE)),
        },
        kind,
        organizationId,
      }),
      options,
      open: true,
    };
    active = current;
    database.guard.open = true;
    const result: TResult = await activeTransaction.run(current, () =>
      work(current.scope as unknown as TransactionScope<TSchema>),
    );
    const committed: { command: string } = await connection.query('COMMIT');
    if (committed.command === 'ROLLBACK') {
      throw new TransactionAbortedError();
    }
    return result;
  } catch (error) {
    try {
      await connection.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    if (active !== undefined) {
      active.open = false;
    }
    database.guard.open = false;
    connection.removeListener('error', onConnectionError);
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
 * the connection and commits or rolls back with the outer one. Once a transaction is over its
 * scope is dead: its `client` and `db` reject, and a later `run` opens a new transaction.
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
   * @param {TransactionOptions} options - Isolation level and read-only flag of a new transaction; a joined transaction must already be at least as strict.
   * @returns {Promise<TResult>} What the work returns, once committed.
   * @throws {Error} When there is no organization in the context, its id is not a UUID, the current transaction is a system one or belongs to another organization, or it is less strict than asked.
   * @throws {TransactionAbortedError} When PostgreSQL rolled the transaction back instead of committing it.
   */
  public async run<TResult>(
    work: (scope: TransactionScope<TSchema>) => Promise<TResult>,
    options: TransactionOptions = {},
  ): Promise<TResult> {
    const organizationId: string = requireOrganizationId();
    if (!UUID_PATTERN.test(organizationId)) {
      throw new Error('The organization id of the context is not a UUID.');
    }
    const active: ActiveTransaction | undefined = openTransaction();
    if (active !== undefined) {
      if (active.scope.kind !== 'tenant' || active.scope.organizationId !== organizationId) {
        throw new Error(
          'A tenant transaction cannot start inside a system transaction or one of another organization.',
        );
      }
      assertJoinable(active, options);
      return work(active.scope as unknown as TransactionScope<TSchema>);
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
   * @param {TransactionOptions} options - Isolation level and read-only flag of a new transaction; a joined transaction must already be at least as strict.
   * @returns {Promise<TResult>} What the work returns, once committed.
   * @throws {Error} When the current transaction is a tenant one (a use case never widens its own access) or is less strict than asked.
   * @throws {TransactionAbortedError} When PostgreSQL rolled the transaction back instead of committing it.
   */
  public async run<TResult>(
    work: (scope: TransactionScope<TSchema>) => Promise<TResult>,
    options: TransactionOptions = {},
  ): Promise<TResult> {
    const active: ActiveTransaction | undefined = openTransaction();
    if (active !== undefined) {
      if (active.scope.kind !== 'system') {
        throw new Error('A system transaction cannot start inside a tenant transaction.');
      }
      assertJoinable(active, options);
      return work(active.scope as unknown as TransactionScope<TSchema>);
    }
    return runTransaction(this.pool, this.schema, 'system', null, work, options);
  }
  // #endregion
}
