import { AsyncLocalStorage } from 'node:async_hooks';

import type { Pool } from 'pg';

import type {
  DatabaseSchema,
  TransactionOptions,
  TransactionScope,
} from './transaction-contracts.js';

/**
 * Interface ActiveTransaction
 *
 * @description
 * Transaction and its effective options in the current asynchronous call chain.
 */
interface ActiveTransaction {
  // #region Properties
  /**
   * Property scope
   *
   * @description
   * Scope shared by callbacks that join this transaction.
   *
   * @type {TransactionScope<DatabaseSchema>}
   * @readonly
   */
  readonly scope: TransactionScope<DatabaseSchema>;

  /**
   * Property database
   *
   * @description
   * Database identity that nested runners must share to reuse the scope.
   *
   * @type {TransactionDatabaseIdentity<DatabaseSchema>}
   * @readonly
   */
  readonly database: TransactionDatabaseIdentity<DatabaseSchema>;

  /**
   * Property options
   *
   * @description
   * Effective options of the owning transaction.
   *
   * @type {TransactionOptions}
   * @readonly
   */
  readonly options: TransactionOptions;

  /**
   * Property isOpen
   *
   * @description
   * Whether the owner still accepts work on the scope.
   *
   * @type {() => boolean}
   * @readonly
   */
  readonly isOpen: () => boolean;
  // #endregion
}

/**
 * Interface TransactionDatabaseIdentity
 *
 * @description
 * Pool and schema instance bound to a transaction runner.
 */
interface TransactionDatabaseIdentity<TSchema extends DatabaseSchema> {
  // #region Properties
  /**
   * Property pool
   *
   * @description
   * Pool that owns the checked-out connection.
   *
   * @type {Pool}
   * @readonly
   */
  readonly pool: Pool;

  /**
   * Property schema
   *
   * @description
   * Schema instance used to construct the scope's Drizzle database.
   *
   * @type {TSchema | undefined}
   * @readonly
   */
  readonly schema: TSchema | undefined;
  // #endregion
}

/**
 * Constant activeTransaction
 *
 * @description
 * Carries the checked-out transaction through the asynchronous work that owns or joins it.
 *
 * @type {AsyncLocalStorage<ActiveTransaction>}
 */
const activeTransaction: AsyncLocalStorage<ActiveTransaction> =
  new AsyncLocalStorage<ActiveTransaction>();

/**
 * Constant ISOLATION_RANK
 *
 * @description
 * Orders supported isolation levels so nested runners can reject a weaker ambient transaction.
 *
 * @type {Readonly<Record<'default' | NonNullable<TransactionOptions['isolationLevel']>, number>>}
 */
const ISOLATION_RANK: Readonly<
  Record<'default' | NonNullable<TransactionOptions['isolationLevel']>, number>
> = { default: 0, 'read committed': 0, 'repeatable read': 1, serializable: 2 };

/**
 * Function runInTransactionContext
 *
 * @description
 * Associates the transaction with its callback. The executor controls the scope's lifetime.
 *
 * @param {TransactionScope<TSchema>} scope - Live scope bound to the current PostgreSQL transaction.
 * @param {TransactionDatabaseIdentity<TSchema>} database - Pool and schema identity that nested runners must share.
 * @param {TransactionOptions} options - Isolation and read-only requirements for the transaction.
 * @param {() => boolean} isOpen - Reports whether the transaction owner still accepts queries.
 * @param {(scope: TransactionScope<TSchema>) => Promise<TResult>} work - Callback that runs with the checked-out transaction scope.
 * @returns {Promise<TResult>} The result of the callback running in the transaction context.
 */
export function runInTransactionContext<TSchema extends DatabaseSchema, TResult>(
  scope: TransactionScope<TSchema>,
  database: TransactionDatabaseIdentity<TSchema>,
  options: TransactionOptions,
  isOpen: () => boolean,
  work: (scope: TransactionScope<TSchema>) => Promise<TResult>,
): Promise<TResult> {
  return activeTransaction.run({ scope, database, options, isOpen }, () => work(scope));
}

/**
 * Function getActiveTransaction
 *
 * @description
 * Returns the live transaction scope, if the current asynchronous work has one.
 *
 * @returns {TransactionScope<DatabaseSchema> | undefined} The open scope, or undefined after it closes or when none exists.
 */
export function getActiveTransaction(): TransactionScope<DatabaseSchema> | undefined {
  const current: ActiveTransaction | undefined = activeTransaction.getStore();
  return current?.isOpen() === true ? current.scope : undefined;
}

/**
 * Function assertNoActiveTransaction
 *
 * @description
 * Rejects work that must run outside any live transaction in the current call chain.
 *
 * @throws {Error} When the current asynchronous work owns or joins an open transaction.
 */
export function assertNoActiveTransaction(): void {
  if (getActiveTransaction() !== undefined) {
    throw new Error('This operation must run outside an active transaction.');
  }
}

/**
 * Function joinActiveTransaction
 *
 * @description
 * Finds the ambient transaction and checks that it provides the caller's requirements.
 *
 * @param {TransactionDatabaseIdentity<TSchema>} database - Pool and schema identity that nested runners must share.
 * @param {TransactionOptions} requested - Isolation and read-only options required by the nested work.
 * @param {(scope: TransactionScope<DatabaseSchema>) => void} assertAccess - Checks the organization and transaction kind before joining.
 * @returns {TransactionScope<TSchema> | undefined} The compatible open scope, or undefined when a new transaction is needed.
 * @throws {Error} When the live scope does not meet the access, database or transaction requirements.
 */
export function joinActiveTransaction<TSchema extends DatabaseSchema>(
  database: TransactionDatabaseIdentity<TSchema>,
  requested: TransactionOptions,
  assertAccess: (scope: TransactionScope<DatabaseSchema>) => void,
): TransactionScope<TSchema> | undefined {
  const current: ActiveTransaction | undefined = activeTransaction.getStore();
  if (current?.isOpen() !== true) {
    return undefined;
  }

  assertAccess(current.scope);
  if (current.database.pool !== database.pool || current.database.schema !== database.schema) {
    throw new Error('A nested transaction must use the same PostgreSQL pool and schema instance.');
  }
  const isolation: 'default' | NonNullable<TransactionOptions['isolationLevel']> =
    requested.isolationLevel ?? 'default';
  if (ISOLATION_RANK[isolation] > ISOLATION_RANK[current.options.isolationLevel ?? 'default']) {
    throw new Error(
      `The running transaction cannot provide the ${isolation} isolation level: open the outer transaction with it.`,
    );
  }
  if (requested.readOnly === true && current.options.readOnly !== true) {
    throw new Error(
      'The running transaction cannot provide read-only access: open the outer transaction as read-only.',
    );
  }

  return current.scope as TransactionScope<TSchema>;
}
