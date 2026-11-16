import type { Histogram } from '@opentelemetry/api';
import type { Pool, PoolClient } from 'pg';

import { ORGANIZATION_SETTING, SYSTEM_ACCESS_SETTING } from '../policies/organization-policy.js';
import { runInTransactionContext } from './transaction-context.js';
import type {
  DatabaseSchema,
  TransactionKind,
  TransactionOptions,
  TransactionScope,
} from './transaction-contracts.js';
import { CLOSED_SCOPE_MESSAGE, createTransactionDatabase } from './transaction-database.js';
import { transactionMetrics } from './transaction-metrics.js';

/**
 * Constant BEGIN_STATEMENTS
 *
 * @description
 * Maps requested isolation levels to fixed SQL, so the caller never assembles isolation clauses.
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
 * Class TransactionAbortedError
 *
 * @description
 * PostgreSQL answered COMMIT with a rollback because the transaction was already aborted.
 */
export class TransactionAbortedError extends Error {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Reports the unexpected rollback to callers of the runner.
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
 * Function acquireConnection
 *
 * @description
 * Checks out a PostgreSQL connection and records the elapsed time even if checkout fails.
 *
 * @param {Pool} pool - PostgreSQL pool that owns the checked-out connection.
 * @param {TransactionKind} kind - Tenant or system transaction kind, also recorded on transaction metrics.
 * @param {Histogram} poolAcquireDuration - Histogram used to record checkout duration in milliseconds.
 * @returns {Promise<PoolClient>} A checked-out client that the transaction executor must release.
 */
async function acquireConnection(
  pool: Pool,
  kind: TransactionKind,
  poolAcquireDuration: Histogram,
): Promise<PoolClient> {
  const started: number = performance.now();
  let outcome: 'success' | 'error' = 'error';
  try {
    const connection: PoolClient = await pool.connect();
    outcome = 'success';
    return connection;
  } finally {
    poolAcquireDuration.record(performance.now() - started, { kind, outcome });
  }
}

/**
 * Function executeTransaction
 *
 * @description
 * Acquires a connection, sets its transaction-local RLS parameters, and runs the callback.
 * Invalidates the scope before commit or rollback and discards a connection that failed.
 *
 * @param {Pool} pool - PostgreSQL pool that owns the checked-out connection.
 * @param {TSchema | undefined} schema - Optional Drizzle schema for the scoped database.
 * @param {TransactionKind} kind - Tenant or system transaction kind, also recorded on transaction metrics.
 * @param {string | null} organizationId - Organization whose data is scoped, or null for system work.
 * @param {(scope: TransactionScope<TSchema>) => Promise<TResult>} work - Callback that runs with the checked-out transaction scope.
 * @param {TransactionOptions} options - Isolation and read-only requirements for the transaction.
 * @returns {Promise<TResult>} The callback result after commit, or a rejection after rollback.
 */
export async function executeTransaction<TSchema extends DatabaseSchema, TResult>(
  pool: Pool,
  schema: TSchema | undefined,
  kind: TransactionKind,
  organizationId: string | null,
  work: (scope: TransactionScope<TSchema>) => Promise<TResult>,
  options: TransactionOptions,
): Promise<TResult> {
  const { poolAcquireDuration, transactionDuration } = transactionMetrics();
  const connection: PoolClient = await acquireConnection(pool, kind, poolAcquireDuration);
  const started: number = performance.now();
  let open: boolean = true;
  let broken: boolean = false;
  let outcome: 'success' | 'error' = 'error';
  // The pool removes its own error listener while a connection is checked out.
  const onConnectionError: () => void = (): void => {
    broken = true;
  };
  connection.on('error', onConnectionError);
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
    const isOpen: () => boolean = (): boolean => open;
    const scope: TransactionScope<TSchema> = Object.freeze({
      db: createTransactionDatabase(connection, schema, isOpen),
      client: {
        query: (text: string, values?: unknown[]): Promise<{ rows: unknown[] }> =>
          open ? connection.query(text, values) : Promise.reject(new Error(CLOSED_SCOPE_MESSAGE)),
      },
      kind,
      organizationId,
    });
    const result: TResult = await runInTransactionContext(
      scope,
      { pool, schema },
      options,
      isOpen,
      work,
    );
    open = false;
    const committed: { command: string } = await connection.query('COMMIT');
    if (committed.command === 'ROLLBACK') {
      throw new TransactionAbortedError();
    }
    outcome = 'success';
    return result;
  } catch (error) {
    open = false;
    try {
      await connection.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    connection.removeListener('error', onConnectionError);
    connection.release(broken);
    transactionDuration.record(performance.now() - started, { kind, outcome });
  }
}
