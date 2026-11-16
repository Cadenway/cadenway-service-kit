import { JetStreamApiError } from '@nats-io/jetstream';
import { PermissionViolationError } from '@nats-io/transport-node';

import { isMessagingUnavailable } from '../../publisher/event-publisher.js';

/**
 * Constant MAX_ATTEMPTS
 *
 * @description
 * Number of row-specific failures that parks an outbox row until explicit requeue.
 *
 * @type {number}
 */
const MAX_ATTEMPTS: number = 20;
/**
 * Constant ROW_BACKOFF_BASE_MS
 *
 * @description
 * Delay after the first row-specific failure, in milliseconds.
 *
 * @type {number}
 */
const ROW_BACKOFF_BASE_MS: number = 1000;
/**
 * Constant ROW_BACKOFF_MAX_MS
 *
 * @description
 * Upper bound on delay between retries of one row, in milliseconds.
 *
 * @type {number}
 */
const ROW_BACKOFF_MAX_MS: number = 300_000;
/**
 * Constant PASS_BACKOFF_MAX_MS
 *
 * @description
 * Upper bound on delay after a relay-wide failure, in milliseconds.
 *
 * @type {number}
 */
const PASS_BACKOFF_MAX_MS: number = 30_000;

/**
 * Constant RESOURCE_LIMIT_CODES
 *
 * @description
 * JetStream codes for account, storage or memory exhaustion and store failures. These failures do not consume a row attempt.
 *
 * @type {ReadonlySet<number>}
 */
const RESOURCE_LIMIT_CODES: ReadonlySet<number> = new Set([10002, 10023, 10028, 10047, 10077]);

/**
 * Function rowBackoffMs
 *
 * @description
 * Delay before retrying one failed row, doubling from one second to at most five minutes.
 *
 * @param {number} attempts - Failure count of the row, including the latest failure.
 * @returns {number} Row retry delay in milliseconds.
 */
export function rowBackoffMs(attempts: number): number {
  return Math.min(ROW_BACKOFF_BASE_MS * 2 ** Math.max(attempts - 1, 0), ROW_BACKOFF_MAX_MS);
}

/**
 * Function passBackoffMs
 *
 * @description
 * Delay before polling again, with a bounded exponential backoff for relay-wide failures.
 *
 * @param {number} pollIntervalMs - Base polling interval, in milliseconds.
 * @param {number} failedPasses - Consecutive relay-wide failures since the last healthy pass.
 * @returns {number} Milliseconds to wait before the next pass.
 */
export function passBackoffMs(pollIntervalMs: number, failedPasses: number): number {
  return Math.min(pollIntervalMs * 2 ** failedPasses, PASS_BACKOFF_MAX_MS);
}

/**
 * Function stopsPass
 *
 * @description
 * Classifies errors that stop the whole batch without charging an attempt to that row.
 *
 * @param {unknown} error - Failure raised while attempting broker publication.
 * @returns {boolean} Whether the relay should back off without counting a row-specific failure.
 */
export function stopsPass(error: unknown): boolean {
  if (isMessagingUnavailable(error) || error instanceof PermissionViolationError) {
    return true;
  }
  if (error instanceof Error && error.cause instanceof PermissionViolationError) {
    return true;
  }
  return error instanceof JetStreamApiError && RESOURCE_LIMIT_CODES.has(error.code);
}

/**
 * Interface FailedOutboxAttempt
 *
 * @description
 * Retry state to persist after an unsuccessful publication of one row.
 */
export interface FailedOutboxAttempt {
  // #region Properties
  /**
   * Property attempts
   *
   * @description
   * Attempt count including the failure just observed.
   *
   * @type {number}
   * @readonly
   */
  readonly attempts: number;

  /**
   * Property parked
   *
   * @description
   * Whether the row has no retry remaining before an explicit requeue.
   *
   * @type {boolean}
   * @readonly
   */
  readonly parked: boolean;

  /**
   * Property delayMs
   *
   * @description
   * Delay before the row becomes due for another attempt, in milliseconds.
   *
   * @type {number}
   * @readonly
   */
  readonly delayMs: number;
  // #endregion
}

/**
 * Function nextOutboxAttempt
 *
 * @description
 * Advances an individual row's retry state and parks it after its last allowed attempt.
 *
 * @param {number} previousAttempts - Row-specific failures already recorded for the event.
 * @returns {FailedOutboxAttempt} New failure count, retry delay and parking decision.
 */
export function nextOutboxAttempt(previousAttempts: number): FailedOutboxAttempt {
  const attempts: number = previousAttempts + 1;
  return { attempts, parked: attempts >= MAX_ATTEMPTS, delayMs: rowBackoffMs(attempts) };
}
