import type { Pool } from 'pg';

import { joinActiveTransaction } from './transaction-context.js';
import type {
  DatabaseSchema,
  TransactionOptions,
  TransactionScope,
} from './transaction-contracts.js';
import { executeTransaction } from './transaction-executor.js';

/**
 * Runs work that legitimately crosses organizations or belongs to none. Row-level security
 * accepts the system setting, so queries must explicitly constrain the rows they intend to use.
 */
export class SystemTransactionRunner<TSchema extends DatabaseSchema = Record<string, never>> {
  // #region Constructor
  /** Binds the runner to the service's pool and optional schema. */
  public constructor(
    private readonly pool: Pool,
    private readonly schema?: TSchema,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Joins a compatible system transaction or opens one and commits it on success.
   * Rejects a call from within a tenant transaction, which cannot widen its own access.
   */
  public async run<TResult>(
    work: (scope: TransactionScope<TSchema>) => Promise<TResult>,
    options: TransactionOptions = {},
  ): Promise<TResult> {
    const active: TransactionScope<TSchema> | undefined = joinActiveTransaction<TSchema>(
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
