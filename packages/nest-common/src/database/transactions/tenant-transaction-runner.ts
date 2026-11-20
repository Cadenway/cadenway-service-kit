import type { Pool } from 'pg';

import { requireOrganizationId } from '../../auth/context/organization-context.js';
import { joinActiveTransaction } from './transaction-context.js';
import type {
  DatabaseSchema,
  TransactionOptions,
  TransactionScope,
} from './transaction-contracts.js';
import { executeTransaction } from './transaction-executor.js';
import { retryTransaction } from './transaction-retry.js';

// The policies cast the organization id to uuid in PostgreSQL.
/**
 * Constant UUID_PATTERN
 *
 * @description
 * Rejects organization ids PostgreSQL could not cast to a UUID in the row-level policies.
 *
 * @type {RegExp}
 */
const UUID_PATTERN: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Class TenantTransactionRunner
 *
 * @description
 * Runs a transaction for the organization of the verified request context. Its RLS setting
 * restricts rows to that organization, in addition to the explicit filters of the queries.
 */
export class TenantTransactionRunner<TSchema extends DatabaseSchema = Record<string, never>> {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Binds the runner to the service's pool and optional schema.
   *
   * @param {Pool} pool - PostgreSQL pool that owns the checked-out connection.
   * @param {TSchema | undefined} schema - Optional Drizzle schema for the scoped database.
   * @param {number} maxAttempts - Default maximum total attempts, or 1 to disable retries.
   * @constructor
   */
  public constructor(
    private readonly pool: Pool,
    private readonly schema?: TSchema,
    private readonly maxAttempts: number = 3,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Method run
   *
   * @description
   * Joins a transaction of the same organization, pool and schema, or opens one and commits it on
   * success. Rejects missing organization context or a nested request that would change access.
   *
   * @param {(scope: TransactionScope<TSchema>) => Promise<TResult>} work - Callback that runs with the checked-out transaction scope.
   * @param {TransactionOptions} options - Isolation and read-only requirements for the transaction.
   * @returns {Promise<TResult>} The work result after commit when this runner owns the transaction.
   */
  public async run<TResult>(
    work: (scope: TransactionScope<TSchema>) => Promise<TResult>,
    options: TransactionOptions = {},
  ): Promise<TResult> {
    const organizationId: string = requireOrganizationId();
    if (!UUID_PATTERN.test(organizationId)) {
      throw new Error('The organization id of the context is not a UUID.');
    }
    const active: TransactionScope<TSchema> | undefined = joinActiveTransaction<TSchema>(
      { pool: this.pool, schema: this.schema },
      options,
      (scope: TransactionScope<DatabaseSchema>) => {
        if (scope.kind !== 'tenant' || scope.organizationId !== organizationId) {
          throw new Error(
            'A tenant transaction cannot start inside a system transaction or one of another organization.',
          );
        }
      },
    );
    return active === undefined
      ? retryTransaction(
          () => executeTransaction(this.pool, this.schema, 'tenant', organizationId, work, options),
          options.maxAttempts ?? this.maxAttempts,
        )
      : work(active);
  }
  // #endregion
}
