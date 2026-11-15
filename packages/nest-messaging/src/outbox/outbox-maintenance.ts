import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';

import { OUTBOX_RETENTION_DAYS, PROCESSED_EVENTS_RETENTION_DAYS } from './outbox-options.js';

/**
 * Function countOf
 *
 * @description
 * Reads the `count` column of the single row a counting statement returns.
 *
 * @param {{ rows: unknown[] }} result - Result of the statement.
 * @returns {number} The count.
 */
function countOf(result: { rows: unknown[] }): number {
  return (result.rows[0] as { count: number }).count;
}

/**
 * Function purgeSentOutboxEvents
 *
 * @description
 * Deletes the outbox rows sent more than a number of days ago. Pending rows are never deleted.
 * The relay calls it periodically; a service that disabled that purge runs it from a scheduled
 * job, in a system transaction.
 *
 * @param {TransactionScope<TDatabase>} tx - Scope of a system transaction.
 * @param {number} olderThanDays - Age of the sent rows to delete, in days; defaults to 7.
 * @returns {Promise<number>} Number of rows deleted.
 */
export async function purgeSentOutboxEvents<TDatabase extends DatabaseSchema>(
  tx: TransactionScope<TDatabase>,
  olderThanDays: number = OUTBOX_RETENTION_DAYS,
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
 * Marks as pending again the outbox rows sent since an instant, so the relay publishes them
 * again: the way to restore what a NATS loss dropped, for the seven days sent rows are kept.
 * Consumers that already handled these events skip them through their processed-ids table.
 *
 * @param {TransactionScope<TDatabase>} tx - Scope of a system transaction.
 * @param {Date} since - Rows sent at or after this instant are published again.
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
            set status = 'pending', sent_at = null
          where status = 'sent' and sent_at >= $1::timestamptz
         returning 1
       )
       select count(*)::int as count from requeued`,
      [since.toISOString()],
    ),
  );
}

/**
 * Function purgeProcessedEvents
 *
 * @description
 * Deletes the processed event ids recorded more than a number of days ago. Keep them at least as
 * long as an event can still be redelivered: seven days in the stream plus seven days during
 * which its outbox row can be published again.
 *
 * @param {TransactionScope<TDatabase>} tx - Scope of a system transaction.
 * @param {number} olderThanDays - Age of the ids to delete, in days; defaults to 14.
 * @returns {Promise<number>} Number of rows deleted.
 */
export async function purgeProcessedEvents<TDatabase extends DatabaseSchema>(
  tx: TransactionScope<TDatabase>,
  olderThanDays: number = PROCESSED_EVENTS_RETENTION_DAYS,
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
