import type { Pool } from 'pg';

import { requireOrganizationId } from '../../auth/context/organization-context.js';
import { joinActiveTransaction } from './transaction-context.js';
import type {
  DatabaseSchema,
  TransactionOptions,
  TransactionScope,
} from './transaction-contracts.js';
import { executeTransaction } from './transaction-executor.js';

// The policies cast the organization id to uuid in PostgreSQL.
const UUID_PATTERN: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Runs a transaction for the organization of the verified request context. Its RLS setting
 * restricts rows to that organization, in addition to the explicit filters of the queries.
 */
export class TenantTransactionRunner<TSchema extends DatabaseSchema = Record<string, never>> {
  // #region Constructor
  /** Binds the runner to the service's pool and optional schema. */
  public constructor(
    private readonly pool: Pool,
    private readonly schema?: TSchema,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Joins a compatible transaction of the same organization, or opens one and commits it on
   * success. Rejects missing organization context or a nested request that would change access.
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
      ? executeTransaction(this.pool, this.schema, 'tenant', organizationId, work, options)
      : work(active);
  }
  // #endregion
}
