import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';

import { releaseExpiredOutboxLeases } from './outbox-lease-store.js';

/**
 * Function recoverExpiredOutboxLeases
 *
 * @description
 * Returns one batch of expired leases to pending in the caller's system transaction. Use it
 * before re-enabling the legacy relay during rollback.
 *
 * @param {TransactionScope<TDatabase>} tx - System transaction of the service database.
 * @param {number} limit - Maximum rows to release. Defaults to 100 and accepts integers from 1 to 1000.
 * @returns {Promise<number>} Number of leases released by this transaction.
 * @throws When the transaction is not a system transaction or the limit is out of range.
 */
export async function recoverExpiredOutboxLeases<TDatabase extends DatabaseSchema>(
  tx: TransactionScope<TDatabase>,
  limit: number = 100,
): Promise<number> {
  if (tx.kind !== 'system') {
    throw new Error('Recovering outbox leases requires a system transaction.');
  }
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) {
    throw new Error('Outbox recovery limit must be an integer between 1 and 1000.');
  }
  return releaseExpiredOutboxLeases(tx.client, limit);
}
