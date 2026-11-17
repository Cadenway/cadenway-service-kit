import type { Pool } from 'pg';

import { joinActiveTransaction } from './transaction-context.js';
import type {
  DatabaseSchema,
  TransactionOptions,
  TransactionScope,
} from './transaction-contracts.js';
import { executeTransaction } from './transaction-executor.js';

/**
 * Class SystemTransactionRunner
 *
 * @description
 * Runs work that legitimately crosses organizations or belongs to none. Row-level security
 * accepts the system setting, so queries must explicitly constrain the rows they intend to use.
 */
export class SystemTransactionRunner<TSchema extends DatabaseSchema = Record<string, never>> {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Binds the runner to the service's pool and optional schema.
   *
   * @param {Pool} pool - PostgreSQL pool that owns the checked-out connection.
   * @param {TSchema | undefined} schema - Optional Drizzle schema for the scoped database.
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
   * Joins a system transaction on the same pool and schema or opens one and commits it on success.
   * Rejects calls inside a tenant transaction or a transaction bound to a different database.
   *
   * @param {(scope: TransactionScope<TSchema>) => Promise<TResult>} work - Callback that runs with the checked-out transaction scope.
   * @param {TransactionOptions} options - Isolation and read-only requirements for the transaction.
   * @returns {Promise<TResult>} The work result after commit when this runner owns the transaction.
   */
  public async run<TResult>(
    work: (scope: TransactionScope<TSchema>) => Promise<TResult>,
    options: TransactionOptions = {},
  ): Promise<TResult> {
    const active: TransactionScope<TSchema> | undefined = joinActiveTransaction<TSchema>(
      { pool: this.pool, schema: this.schema },
      options,
      (scope: TransactionScope<DatabaseSchema>) => {
        if (scope.kind !== 'system') {
          throw new Error('A system transaction cannot start inside a tenant transaction.');
        }
      },
    );
    return active === undefined
      ? executeTransaction(this.pool, this.schema, 'system', null, work, options)
      : work(active);
  }
  // #endregion
}
