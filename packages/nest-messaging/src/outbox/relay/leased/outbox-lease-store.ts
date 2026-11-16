import { randomUUID } from 'node:crypto';

import type { TransactionClient } from '@cadenway/nest-common/database';

import { REDACTED_PAYLOAD_SQL } from '../../maintenance/outbox-redaction.js';
import { inspectOutboxLeaseSchema } from '../../schema/inspect-outbox-lease-schema.js';
import type { PendingRow } from '../outbox-relay-store.js';

/**
 * Interface LeasedRow
 *
 * @description
 * An outbox row reserved until the recorded deadline.
 */
export interface LeasedRow extends PendingRow {
  // #region Properties
  /**
   * Property lease_token
   *
   * @description
   * Token assigned by the reservation transaction.
   *
   * @type {string}
   * @readonly
   */
  readonly lease_token: string;

  /**
   * Property queued_ms
   *
   * @description
   * Age in milliseconds at the time of this reservation.
   *
   * @type {number}
   * @readonly
   */
  readonly queued_ms: number;
  // #endregion
}

/**
 * Interface LeaseOutcome
 *
 * @description
 * The only changes allowed to follow an attempt, fenced by its lease token.
 */
export interface LeaseOutcome {
  // #region Properties
  /**
   * Property id
   *
   * @description
   * Event identifier of the reserved row.
   *
   * @type {string}
   * @readonly
   */
  readonly id: string;

  /**
   * Property lease_token
   *
   * @description
   * Reservation token that prevents a stale relay from settling a reclaimed row.
   *
   * @type {string}
   * @readonly
   */
  readonly lease_token: string;

  /**
   * Property status
   *
   * @description
   * State to persist once this attempt settles.
   *
   * @type {'pending' | 'sent' | 'failed'}
   * @readonly
   */
  readonly status: 'pending' | 'sent' | 'failed';

  /**
   * Property attempts
   *
   * @description
   * Accumulated row-specific attempts to record after settlement.
   *
   * @type {number}
   * @readonly
   */
  readonly attempts: number;

  /**
   * Property retry_ms
   *
   * @description
   * Delay relative to settlement before the row can be claimed again, in milliseconds.
   *
   * @type {number}
   * @readonly
   */
  readonly retry_ms: number;

  /**
   * Property last_error
   *
   * @description
   * Safe error class for the most recent failure, or null on success.
   *
   * @type {string | null}
   * @readonly
   */
  readonly last_error: string | null;

  /**
   * Property redact
   *
   * @description
   * Whether settlement replaces a restricted payload with its envelope and redaction marker.
   *
   * @type {boolean}
   * @readonly
   */
  readonly redact: boolean;
  // #endregion
}

/**
 * Function hasOutboxLeaseSchema
 *
 * @description
 * Checks that both constraints and the expected expiry index are valid for the active outbox.
 *
 * @param {TransactionClient} client - System transaction client whose search path selects the active outbox table.
 * @returns {Promise<boolean>} Whether the active outbox is ready for the lease relay.
 */
export async function hasOutboxLeaseSchema(client: TransactionClient): Promise<boolean> {
  const schema = await inspectOutboxLeaseSchema(client, 'outbox_events');
  return schema?.index_state === 'valid' && schema.checks_valid;
}

/**
 * Function claimOutboxRows
 *
 * @description
 * Claims up to the available slots, replacing tokens of expired reservations.
 *
 * @param {TransactionClient} client - System transaction client reserving rows and assigning new tokens.
 * @param {number} limit - Maximum number of active publication slots to fill.
 * @param {number} leaseMs - Duration for which the new tokens are valid, in milliseconds.
 * @returns {Promise<readonly LeasedRow[]>} Claimed rows and their new reservation tokens.
 */
export async function claimOutboxRows(
  client: TransactionClient,
  limit: number,
  leaseMs: number,
): Promise<readonly LeasedRow[]> {
  const { rows }: { rows: unknown[] } = await client.query(
    `with expired as materialized (
       select id from outbox_events
        where status = 'leased' and lease_expires_at <= statement_timestamp()
        order by lease_expires_at, id
        limit $1 for update skip locked
     ), pending as (
       select id from outbox_events
        where status = 'pending' and next_attempt_at <= statement_timestamp()
        order by next_attempt_at, created_at, id
        limit ($1 - (select count(*) from expired)) for update skip locked
     )
     update outbox_events as events
        set status = 'leased',
            lease_token = $2,
            lease_expires_at = statement_timestamp() + make_interval(secs => $3::double precision)
      where events.id in (select id from expired union all select id from pending)
      returning events.id, events.event_name, events.subject, events.stream, events.payload,
                events.traceparent, events.attempts, events.lease_token,
                (extract(epoch from statement_timestamp() - events.created_at) * 1000)::double precision
                  as queued_ms`,
    [limit, randomUUID(), leaseMs / 1000],
  );
  return rows as LeasedRow[];
}

/**
 * Function settleOutboxLeases
 *
 * @description
 * Settles current leases as a batch and returns the ids actually updated.
 *
 * @param {TransactionClient} client - System transaction client applying the fenced updates.
 * @param {readonly LeaseOutcome[]} outcomes - Outcomes keyed by event ID and by the token held when publication started.
 * @returns {Promise<ReadonlySet<string>>} Event IDs whose outcomes were saved under still-valid lease tokens.
 */
export async function settleOutboxLeases(
  client: TransactionClient,
  outcomes: readonly LeaseOutcome[],
): Promise<ReadonlySet<string>> {
  const { rows }: { rows: unknown[] } = await client.query(
    `update outbox_events as events
        set status = outcome.status,
            attempts = outcome.attempts,
            last_error = outcome.last_error,
            sent_at = case when outcome.status = 'sent' then statement_timestamp() end,
            next_attempt_at = statement_timestamp()
              + make_interval(secs => outcome.retry_ms::double precision / 1000),
            payload = case when outcome.redact then ${REDACTED_PAYLOAD_SQL} else events.payload end,
            lease_token = null,
            lease_expires_at = null
       from jsonb_to_recordset($1::jsonb) as outcome(
         id uuid, lease_token uuid, status text, attempts integer, retry_ms integer,
         last_error text, redact boolean
       )
      where events.id = outcome.id
        and events.status = 'leased'
        and events.lease_token = outcome.lease_token
        and events.lease_expires_at > statement_timestamp()
      returning events.id`,
    [JSON.stringify(outcomes)],
  );
  return new Set((rows as { id: string }[]).map(({ id }: { id: string }) => id));
}

/**
 * Function releaseExpiredOutboxLeases
 *
 * @description
 * Restores an expired batch for the legacy relay during rollback.
 *
 * @param {TransactionClient} client - System transaction client releasing expired reservations.
 * @param {number} limit - Maximum rows to return to pending.
 * @returns {Promise<number>} Number of expired reservations returned to pending.
 */
export async function releaseExpiredOutboxLeases(
  client: TransactionClient,
  limit: number,
): Promise<number> {
  const { rows }: { rows: unknown[] } = await client.query(
    `with picked as (
       select id from outbox_events
        where status = 'leased' and lease_expires_at <= statement_timestamp()
        order by lease_expires_at, id
        limit $1 for update skip locked
     ), released as (
       update outbox_events
          set status = 'pending', lease_token = null, lease_expires_at = null
        where id in (select id from picked)
        returning 1
     )
     select count(*)::int as count from released`,
    [limit],
  );
  return (rows[0] as { count: number }).count;
}
