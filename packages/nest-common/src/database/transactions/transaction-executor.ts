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

const BEGIN_STATEMENTS: Readonly<
  Record<'default' | NonNullable<TransactionOptions['isolationLevel']>, string>
> = {
  default: 'BEGIN',
  'read committed': 'BEGIN ISOLATION LEVEL READ COMMITTED',
  'repeatable read': 'BEGIN ISOLATION LEVEL REPEATABLE READ',
  serializable: 'BEGIN ISOLATION LEVEL SERIALIZABLE',
};

/** PostgreSQL answered COMMIT with a rollback because the transaction was already aborted. */
export class TransactionAbortedError extends Error {
  // #region Constructor
  /** Reports the unexpected rollback to callers of the runner. */
  public constructor() {
    super(
      'The transaction was rolled back at commit: a statement failed inside it and its error was not propagated.',
    );
    this.name = 'TransactionAbortedError';
  }
  // #endregion
}

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
 * Acquires a connection, sets its transaction-local RLS parameters, and runs the callback.
 * Invalidates the scope before commit or rollback and discards a connection that failed.
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
    const result: TResult = await runInTransactionContext(scope, options, isOpen, work);
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
