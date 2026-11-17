import type { TransactionClient } from '@cadenway/nest-common/database';

import type { EventEnvelope } from '../../events/event-envelope.js';
import { REDACTED_PAYLOAD_SQL } from '../maintenance/outbox-redaction.js';
import type { FailedOutboxAttempt } from './outbox-retry-policy.js';

/**
 * Interface PendingRow
 *
 * @description
 * Columns selected from a pending row. The writer validates the envelope before insertion.
 */
export interface PendingRow {
  // #region Properties
  /**
   * Property id
   *
   * @description
   * Event id and row primary key.
   *
   * @type {string}
   * @readonly
   */
  readonly id: string;

  /**
   * Property event_name
   *
   * @description
   * Contract event name persisted by the writer.
   *
   * @type {string}
   * @readonly
   */
  readonly event_name: string;

  /**
   * Property subject
   *
   * @description
   * Broker subject chosen by the writer for the event.
   *
   * @type {string}
   * @readonly
   */
  readonly subject: string;

  /**
   * Property stream
   *
   * @description
   * Stream expected to acknowledge publication on the stored subject.
   *
   * @type {string}
   * @readonly
   */
  readonly stream: string;

  /**
   * Property payload
   *
   * @description
   * Validated event envelope and payload, or the envelope with its redaction marker.
   *
   * @type {EventEnvelope}
   * @readonly
   */
  readonly payload: EventEnvelope;

  /**
   * Property traceparent
   *
   * @description
   * Original W3C trace context, when the writer had an active span.
   *
   * @type {string | null}
   * @readonly
   */
  readonly traceparent: string | null;

  /**
   * Property attempts
   *
   * @description
   * Row-specific failures recorded before the current pass.
   *
   * @type {number}
   * @readonly
   */
  readonly attempts: number;
  // #endregion
}

/**
 * Function lockPendingRows
 *
 * @description
 * Locks at most one batch of due rows, skipping those held by other relay replicas.
 *
 * @param {TransactionClient} client - Client of the system transaction that will own the row locks.
 * @param {number} batchSize - Maximum number of eligible rows to lock.
 * @returns {Promise<readonly PendingRow[]>} Eligible rows locked by this transaction.
 */
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

/**
 * Function recordOutboxInterruption
 *
 * @description
 * Records a broker-wide failure without charging an attempt to the row.
 *
 * @param {TransactionClient} client - Transaction client that owns the row lock.
 * @param {string} id - Event ID of the row interrupted by a broker-wide failure.
 * @param {string} errorClass - Safe error class to store for diagnostics.
 * @returns {Promise<void>} Resolves after recording the infrastructure error.
 */
export async function recordOutboxInterruption(
  client: TransactionClient,
  id: string,
  errorClass: string,
): Promise<void> {
  await client.query('update outbox_events set last_error = $2 where id = $1', [id, errorClass]);
}

/**
 * Function recordOutboxFailure
 *
 * @description
 * Records a row-specific failure and its next eligibility for publication.
 *
 * @param {TransactionClient} client - Transaction client that owns the row lock.
 * @param {string} id - Event ID of the row whose publication failed.
 * @param {string} errorClass - Safe error class to store for diagnostics.
 * @param {FailedOutboxAttempt} attempt - Updated attempt count, backoff and parking decision.
 * @returns {Promise<void>} Resolves once the pending or parked state is saved.
 */
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
 * Function settleOutboxRows
 *
 * @description
 * Marks acknowledged and previously redacted rows sent. Restricted payloads are replaced in the
 * same statement so a rollback leaves both the payload and sent status unchanged.
 *
 * @param {TransactionClient} client - Transaction client that owns the row locks.
 * @param {readonly string[]} ids - IDs to mark sent, including any already redacted rows.
 * @param {readonly string[]} redactIds - Restricted IDs whose payload must be redacted atomically with the sent update.
 * @returns {Promise<void>} Resolves once sent state and any restricted payload redaction are saved.
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
