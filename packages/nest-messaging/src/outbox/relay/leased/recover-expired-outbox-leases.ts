import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';

import { releaseExpiredOutboxLeases } from './outbox-lease-store.js';

/**
 * Returns up to one batch of expired outbox leases to the pending state for rollback.
 *
 * @param {TransactionScope<TDatabase>} tx - System transaction of the service database.
 * @param {number} [limit=100] - Maximum number of rows to release.
 * @returns {Promise<number>} Number of leases released by this transaction.
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
