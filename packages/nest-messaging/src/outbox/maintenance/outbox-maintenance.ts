import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';

import {
  DEFAULT_OUTBOX_RETENTION_DAYS,
  DEFAULT_PROCESSED_EVENTS_RETENTION_DAYS,
} from '../wiring/outbox-options.js';
import { REDACTED_PAYLOAD_KEY } from './outbox-redaction.js';

/**
 * Function countOf
 *
 * @description
 * Reads the single count returned by an outbox maintenance statement.
 *
 * @param {{ rows: unknown[] }} result - Single-row result of a statement returning the affected row count.
 * @returns {number} Affected row count.
 */
function countOf(result: { rows: unknown[] }): number {
  return (result.rows[0] as { count: number }).count;
}

/**
 * Function purgeSentOutboxEvents
 *
 * @description
 * Deletes only sent outbox rows past the retention window, in the caller's system transaction.
 *
 * @param {TransactionScope<TDatabase>} tx - Scope of the service’s system transaction.
 * @param {number} olderThanDays - Retention in days, defaulting to 7.
 * @returns {Promise<number>} Number of sent rows deleted.
 */
export async function purgeSentOutboxEvents<TDatabase extends DatabaseSchema>(
  tx: TransactionScope<TDatabase>,
  olderThanDays: number = DEFAULT_OUTBOX_RETENTION_DAYS,
): Promise<number> {
  return countOf(
    await tx.client.query(
      `with deleted as (
         delete from outbox_events
          where status = 'sent' and sent_at < now() - make_interval(secs => $1::double precision)
         returning 1
       )
       select count(*)::int as count from deleted`,
      [olderThanDays * 86_400],
    ),
  );
}

/**
 * Function requeueOutboxEvents
 *
 * @description
 * Resets attempts for parked rows and requeues sent rows since the given instant in the caller's
 * system transaction. Previously processed event IDs still deduplicate delivery. Redacted sent
 * rows stay sent because the original payload has been removed.
 *
 * @param {TransactionScope<TDatabase>} tx - Scope of the service’s system transaction.
 * @param {Date} since - Inclusive time boundary for sent rows.
 * @returns {Promise<number>} Number of rows marked pending.
 */
export async function requeueOutboxEvents<TDatabase extends DatabaseSchema>(
  tx: TransactionScope<TDatabase>,
  since: Date,
): Promise<number> {
  return countOf(
    await tx.client.query(
      `with requeued as (
         update outbox_events
            set status = 'pending', sent_at = null, attempts = 0, next_attempt_at = now(),
                last_error = null
          where (status = 'sent' and sent_at >= $1::timestamptz and not (payload ? $2))
             or status = 'failed'
         returning 1
       )
       select count(*)::int as count from requeued`,
      [since.toISOString(), REDACTED_PAYLOAD_KEY],
    ),
  );
}

/**
 * Function purgeProcessedEvents
 *
 * @description
 * Deletes old processed event IDs in the caller's system transaction. Keep IDs for the full
 * broker-retention and outbox replay windows to deduplicate late deliveries.
 *
 * @param {TransactionScope<TDatabase>} tx - Scope of the service’s system transaction.
 * @param {number} olderThanDays - Retention in days, defaulting to 14.
 * @returns {Promise<number>} Number of expired event IDs deleted.
 */
export async function purgeProcessedEvents<TDatabase extends DatabaseSchema>(
  tx: TransactionScope<TDatabase>,
  olderThanDays: number = DEFAULT_PROCESSED_EVENTS_RETENTION_DAYS,
): Promise<number> {
  return countOf(
    await tx.client.query(
      `with deleted as (
         delete from processed_events
          where processed_at < now() - make_interval(secs => $1::double precision)
         returning 1
       )
       select count(*)::int as count from deleted`,
      [olderThanDays * 86_400],
    ),
  );
}
