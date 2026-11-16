import type { TransactionClient } from '@cadenway/nest-common/database';

import type { EventEnvelope } from '../../events/event-envelope.js';
import { REDACTED_PAYLOAD_SQL } from '../maintenance/outbox-redaction.js';
import type { FailedOutboxAttempt } from './outbox-retry-policy.js';

/** Columns selected from a pending row. The writer validates the envelope before insertion. */
export interface PendingRow {
  // #region Properties
  /** Event id and row primary key. */
  readonly id: string;
  readonly event_name: string;
  readonly subject: string;
  readonly stream: string;
  readonly payload: EventEnvelope;
  readonly traceparent: string | null;
  readonly attempts: number;
  // #endregion
}

/** Locks at most one batch of due rows, skipping those held by other relay replicas. */
export async function lockPendingRows(
  client: TransactionClient,
  batchSize: number,
): Promise<readonly PendingRow[]> {
  const selected: { rows: unknown[] } = await client.query(
    `select id, event_name, subject, stream, payload, traceparent, attempts
       from outbox_events
      where status = 'pending' and next_attempt_at <= now()
      order by next_attempt_at, created_at, id
      limit $1
        for update skip locked`,
    [batchSize],
  );
  return selected.rows as PendingRow[];
}

/** Records a broker-wide failure without charging an attempt to the row. */
export async function recordOutboxInterruption(
  client: TransactionClient,
  id: string,
  errorClass: string,
): Promise<void> {
  await client.query('update outbox_events set last_error = $2 where id = $1', [id, errorClass]);
}

/** Records a row-specific failure and its next eligibility for publication. */
export async function recordOutboxFailure(
  client: TransactionClient,
  id: string,
  errorClass: string,
  attempt: FailedOutboxAttempt,
): Promise<void> {
  await client.query(
    `update outbox_events
        set attempts = $2, last_error = $3, status = $4,
            next_attempt_at = statement_timestamp() + make_interval(secs => $5::double precision)
      where id = $1`,
    [
      id,
      attempt.attempts,
      errorClass,
      attempt.parked ? 'failed' : 'pending',
      attempt.delayMs / 1000,
    ],
  );
}

/**
 * Marks acknowledged and previously redacted rows sent. Restricted payloads are replaced in the
 * same statement so a rollback leaves both the payload and sent status unchanged.
 */
export async function settleOutboxRows(
  client: TransactionClient,
  ids: readonly string[],
  redactIds: readonly string[],
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  await client.query(
    `update outbox_events
        set status = 'sent', sent_at = now(), last_error = null,
            payload = case when id = any($2::uuid[]) then ${REDACTED_PAYLOAD_SQL} else payload end
      where id = any($1::uuid[])`,
    [ids, redactIds],
  );
}
