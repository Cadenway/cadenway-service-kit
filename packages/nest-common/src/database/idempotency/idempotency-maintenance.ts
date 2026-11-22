import { lt, sql } from 'drizzle-orm';

import type { DatabaseSchema, TransactionScope } from '../transactions/transaction-contracts.js';
import idempotencyKeys from './idempotency.schema.js';

/**
 * Constant MAX_IDEMPOTENCY_PURGE_BATCH_SIZE
 *
 * @description
 * Caps the number of rows selected for deletion by one batch.
 *
 * @type {number}
 */
const MAX_IDEMPOTENCY_PURGE_BATCH_SIZE: number = 1_000;

/**
 * Function purgeExpiredIdempotencyKeys
 *
 * @description
 * Deletes stored responses past their retention. Run it from a scheduled job, in a system
 * transaction; the interceptor itself never deletes, it only overwrites an expired key that is
 * used again.
 *
 * @param {TransactionScope<TSchema>} scope - Scope of a system transaction.
 * @returns {Promise<number>} Number of rows deleted.
 */
export async function purgeExpiredIdempotencyKeys<TSchema extends DatabaseSchema>(
  scope: TransactionScope<TSchema>,
): Promise<number> {
  const result: { rowCount: number | null } = await scope.db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.expiresAt, sql`now()`));
  return result.rowCount ?? 0;
}

/**
 * Function purgeExpiredIdempotencyKeyBatch
 *
 * @description
 * Deletes one batch of expired stored responses by selecting candidates in expiry order.
 * Locked rows remain eligible for a future run. Run each batch in its own system transaction
 * so its row locks are released before the next batch starts.
 *
 * @param {TransactionScope<TSchema>} scope - Scope of a system transaction.
 * @param {number} limit - Maximum number of rows to delete, an integer from 1 to 1,000.
 * @returns {Promise<number>} Number of rows deleted. A short batch can leave locked rows behind.
 * @throws {Error} If the scope belongs to a tenant transaction.
 * @throws {RangeError} If the limit is outside the supported range.
 */
export async function purgeExpiredIdempotencyKeyBatch<TSchema extends DatabaseSchema>(
  scope: TransactionScope<TSchema>,
  limit: number,
): Promise<number> {
  if (scope.kind !== 'system') {
    throw new Error('Purging expired idempotency keys requires a system transaction.');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_IDEMPOTENCY_PURGE_BATCH_SIZE) {
    throw new RangeError('The idempotency purge batch size must be an integer from 1 to 1,000.');
  }

  const result: { rowCount: number | null } = await scope.db.execute(sql`
    with expired as (
      select ${idempotencyKeys.id}
      from ${idempotencyKeys}
      where ${idempotencyKeys.expiresAt} < now()
      order by ${idempotencyKeys.expiresAt}
      limit ${limit}
      for update skip locked
    )
    delete from ${idempotencyKeys}
    using expired
    where ${idempotencyKeys.id} = expired.id
  `);
  return result.rowCount ?? 0;
}
