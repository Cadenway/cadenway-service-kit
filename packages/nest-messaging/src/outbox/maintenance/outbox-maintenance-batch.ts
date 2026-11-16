import type { TransactionClient } from '@cadenway/nest-common/database';

import {
  REDACTED_PAYLOAD_KEY,
  REDACTED_PAYLOAD_SQL,
  type RestrictedNames,
} from './outbox-redaction.js';

/**
 * Type MaintenancePhase
 *
 * @description
 * The three phases of automatic retention, run in this order.
 *
 * @type {'redact' | 'purge-sent' | 'purge-processed'}
 */
export type MaintenancePhase = 'redact' | 'purge-sent' | 'purge-processed';

/**
 * Constant MAINTENANCE_BATCH_SIZE
 *
 * @description
 * Maximum number of rows changed in one automatic maintenance transaction.
 *
 * @type {number}
 */
export const MAINTENANCE_BATCH_SIZE: number = 100;

/**
 * Constant MAINTENANCE_LOCK_NAME
 *
 * @description
 * Shared database-local lock key for automatic maintenance across replicas.
 *
 * @type {string}
 */
export const MAINTENANCE_LOCK_NAME: string = 'cadenway:nest-messaging:outbox-maintenance';

/**
 * Function maintainOutboxBatch
 *
 * @description
 * One bounded automatic cleanup step. A busy replica yields without waiting or selecting rows.
 *
 * @param {TransactionClient} client - Client of the system transaction that holds the advisory lock.
 * @param {MaintenancePhase} phase - Retention operation to perform in this batch.
 * @param {RestrictedNames} restricted - Persisted route rules for identifying restricted rows.
 * @param {number} retentionDays - Age in days before a sent row or processed event ID is eligible for deletion.
 * @returns {Promise<number | undefined>} Rows changed in this transaction, or undefined if another replica holds the lock.
 */
export async function maintainOutboxBatch(
  client: TransactionClient,
  phase: MaintenancePhase,
  restricted: RestrictedNames,
  retentionDays: number,
): Promise<number | undefined> {
  const locked: { rows: unknown[] } = await client.query(
    'select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as acquired',
    [MAINTENANCE_LOCK_NAME],
  );
  const lock: { acquired?: unknown } | undefined = locked.rows[0] as
    { acquired?: unknown } | undefined;
  if (lock?.acquired !== true) {
    return undefined;
  }

  // NOWAIT makes a locked eligible row retryable. SKIP LOCKED could make a startup sweep
  // appear complete while a legacy row still needs redaction.
  let result: { rows: unknown[] };
  switch (phase) {
    case 'redact':
      result = await client.query(
        `with picked as (
           select id from outbox_events
            where status = 'sent' and (stream = $1 or starts_with(subject, $2))
              and not (payload ? $3)
            order by sent_at limit $4 for update nowait
         ), changed as (
           update outbox_events set payload = ${REDACTED_PAYLOAD_SQL}
            where id in (select id from picked)
           returning 1
         )
         select count(*)::int as count from changed`,
        [
          restricted.restrictedStream,
          `${restricted.restrictedSubjectPrefix}.`,
          REDACTED_PAYLOAD_KEY,
          MAINTENANCE_BATCH_SIZE,
        ],
      );
      break;
    case 'purge-sent':
      result = await client.query(
        `with picked as (
           select id from outbox_events
            where status = 'sent' and sent_at < now() - make_interval(secs => $1::double precision)
            order by sent_at limit $2 for update nowait
         ), changed as (
           delete from outbox_events where id in (select id from picked) returning 1
         )
         select count(*)::int as count from changed`,
        [retentionDays * 86_400, MAINTENANCE_BATCH_SIZE],
      );
      break;
    case 'purge-processed':
      result = await client.query(
        `with picked as (
           select consumer, event_id from processed_events
            where processed_at < now() - make_interval(secs => $1::double precision)
            order by processed_at limit $2 for update nowait
         ), changed as (
           delete from processed_events using picked
            where processed_events.consumer = picked.consumer
              and processed_events.event_id = picked.event_id
           returning 1
         )
         select count(*)::int as count from changed`,
        [retentionDays * 86_400, MAINTENANCE_BATCH_SIZE],
      );
  }
  return (result.rows[0] as { count: number }).count;
}
