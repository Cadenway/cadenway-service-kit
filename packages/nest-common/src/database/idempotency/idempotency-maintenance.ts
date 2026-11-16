import { lt, sql } from 'drizzle-orm';

import type { DatabaseSchema, TransactionScope } from '../transactions/transaction-contracts.js';
import idempotencyKeys from './idempotency.schema.js';

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
