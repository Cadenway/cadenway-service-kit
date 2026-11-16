import { JetStreamApiError } from '@nats-io/jetstream';

/**
 * Function isJetStreamApiError
 *
 * @description
 * Checks whether the JetStream API returned the specified error code.
 *
 * @param {unknown} error - Error to inspect.
 * @param {number} code - Expected JetStream API error code.
 * @returns {boolean} Whether the error carries that code.
 */
export function isJetStreamApiError(error: unknown, code: number): boolean {
  return error instanceof JetStreamApiError && error.code === code;
}
