import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';

import {
  DEFAULT_OUTBOX_RETENTION_DAYS,
  DEFAULT_PROCESSED_EVENTS_RETENTION_DAYS,
} from './outbox-options.js';
import {
  REDACTED_PAYLOAD_KEY,
  REDACTED_PAYLOAD_SQL,
  type RestrictedNames,
} from './outbox-redaction.js';

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
 * Marks as pending again the outbox rows sent since an instant, so the relay publishes them
 * again: the way to restore what a NATS loss dropped, for the seven days sent rows are kept. It
 * also gives the parked rows (`failed`, after 20 failed attempts) a new series of attempts, once
 * their cause is fixed. Consumers that already handled these events skip them through their
 * processed-ids table.
 *
 * A sent restricted row is not requeued: the relay redacted its payload when it published it, so
 * it cannot be published again. A lost single-use code or link is issued again by its owner.
 *
 * @param {TransactionScope<TDatabase>} tx - Scope of a system transaction.
 * @param {Date} since - Rows sent at or after this instant are published again.
 * @returns {Promise<number>} Number of rows marked pending, parked ones included, redacted ones excluded.
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
 * Function redactSentRestrictedOutboxEvents
 *
 * @description
 * Redacts the restricted rows that are sent but still hold their payload: rows sent before the
 * kit redacted them, or by a replica still on an older kit during a rolling deploy. The relay
 * runs it at its first pass and with every purge, so the table converges once every replica runs
 * this kit. It applies the predicate of `isRestrictedRoute` to the stored route and never touches
 * a pending or parked row, which still needs its payload.
 *
 * @param {TransactionScope<TDatabase>} tx - Scope of a system transaction.
 * @param {RestrictedNames} restricted - Restricted stream and subject prefix of the module.
 * @returns {Promise<number>} Number of rows redacted.
 */
export async function redactSentRestrictedOutboxEvents<TDatabase extends DatabaseSchema>(
  tx: TransactionScope<TDatabase>,
  restricted: RestrictedNames,
): Promise<number> {
  return countOf(
    await tx.client.query(
      `with redacted as (
         update outbox_events
            set payload = ${REDACTED_PAYLOAD_SQL}
          where status = 'sent'
            and (stream = $1 or starts_with(subject, $2))
            and not (payload ? $3)
         returning 1
       )
       select count(*)::int as count from redacted`,
      [restricted.restrictedStream, `${restricted.restrictedSubjectPrefix}.`, REDACTED_PAYLOAD_KEY],
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
