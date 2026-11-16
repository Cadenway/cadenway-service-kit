import { JetStreamApiError } from '@nats-io/jetstream';
import { PermissionViolationError } from '@nats-io/transport-node';

import { isMessagingUnavailable } from '../../publisher/event-publisher.js';

const MAX_ATTEMPTS: number = 20;
const ROW_BACKOFF_BASE_MS: number = 1000;
const ROW_BACKOFF_MAX_MS: number = 300_000;
const PASS_BACKOFF_MAX_MS: number = 30_000;

// Account, storage or memory resources exceeded, insufficient resources, or store failed.
const RESOURCE_LIMIT_CODES: ReadonlySet<number> = new Set([10002, 10023, 10028, 10047, 10077]);

/** Delay before retrying one failed row, doubling from one second to at most five minutes. */
export function rowBackoffMs(attempts: number): number {
  return Math.min(ROW_BACKOFF_BASE_MS * 2 ** Math.max(attempts - 1, 0), ROW_BACKOFF_MAX_MS);
}

/** Delay before polling again, with a bounded exponential backoff for relay-wide failures. */
export function passBackoffMs(pollIntervalMs: number, failedPasses: number): number {
  return Math.min(pollIntervalMs * 2 ** failedPasses, PASS_BACKOFF_MAX_MS);
}

/** Classifies errors that stop the whole batch without charging an attempt to that row. */
export function stopsPass(error: unknown): boolean {
  if (isMessagingUnavailable(error) || error instanceof PermissionViolationError) {
    return true;
  }
  if (error instanceof Error && error.cause instanceof PermissionViolationError) {
    return true;
  }
  return error instanceof JetStreamApiError && RESOURCE_LIMIT_CODES.has(error.code);
}

/** Retry state to persist after an unsuccessful publication of one row. */
export interface FailedOutboxAttempt {
  // #region Properties
  /** Attempt count including the failure just observed. */
  readonly attempts: number;
  readonly parked: boolean;
  readonly delayMs: number;
  // #endregion
}

/** Advances an individual row's retry state and parks it after its last allowed attempt. */
export function nextOutboxAttempt(previousAttempts: number): FailedOutboxAttempt {
  const attempts: number = previousAttempts + 1;
  return { attempts, parked: attempts >= MAX_ATTEMPTS, delayMs: rowBackoffMs(attempts) };
}
