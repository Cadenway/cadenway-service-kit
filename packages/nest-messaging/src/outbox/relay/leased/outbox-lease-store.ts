import { randomUUID } from 'node:crypto';

import type { TransactionClient } from '@cadenway/nest-common/database';

import { REDACTED_PAYLOAD_SQL } from '../../maintenance/outbox-redaction.js';
import type { PendingRow } from '../outbox-relay-store.js';

/** An outbox row reserved until the recorded deadline. */
export interface LeasedRow extends PendingRow {
  // #region Properties
  /** Token assigned by the reservation transaction. */
  readonly lease_token: string;

  /** Age in milliseconds at the time of this reservation. */
  readonly queued_ms: number;
  // #endregion
}

/** The only changes allowed to follow an attempt, fenced by its lease token. */
export interface LeaseOutcome {
  // #region Properties
  /** Event identifier of the reserved row. */
  readonly id: string;
  readonly lease_token: string;
  readonly status: 'pending' | 'sent' | 'failed';
  readonly attempts: number;
  readonly retry_ms: number;
  readonly last_error: string | null;
  readonly redact: boolean;
  // #endregion
}

/** Checks the service has installed the additive lease migration. */
export async function hasOutboxLeaseSchema(client: TransactionClient): Promise<boolean> {
  const { rows }: { rows: unknown[] } = await client.query(
    `select exists (
       select 1 from pg_catalog.pg_constraint
        where conrelid = 'outbox_events'::regclass and conname = 'outbox_events_lease_check'
          and convalidated
     ) and exists (
       select 1 from pg_catalog.pg_index as indexes
       join pg_catalog.pg_class as names on names.oid = indexes.indexrelid
        where indexes.indrelid = 'outbox_events'::regclass and indexes.indisvalid
          and names.relname = 'outbox_events_lease_expiry_index'
     ) as present`,
  );
  return (rows[0] as { present?: boolean } | undefined)?.present === true;
}

/** Claims up to the available slots, replacing tokens of expired reservations. */
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

/** Settles current leases as a batch and returns the ids actually updated. */
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

/** Restores an expired batch for the legacy relay during rollback. */
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
