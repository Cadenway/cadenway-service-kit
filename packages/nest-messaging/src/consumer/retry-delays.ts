/**
 * Constant DEFAULT_RETRY_DELAYS_MS
 *
 * @description
 * Delay before each redelivery of an event whose handler failed, in milliseconds: 1 s, 5 s, 30 s
 * and 2 min. Four delays make five deliveries; the fifth failure is final.
 *
 * @type {readonly number[]}
 */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1000, 5000, 30_000, 120_000];

/**
 * Function retryDelayMs
 *
 * @description
 * Returns how long to wait before redelivering a message whose handler just failed.
 *
 * @param {number} deliveryCount - One-based number of the delivery that failed.
 * @param {readonly number[]} delays - Delay after each failed delivery, in milliseconds.
 * @returns {number | undefined} The delay in milliseconds, or `undefined` when that delivery was the last one allowed.
 */
export function retryDelayMs(
  deliveryCount: number,
  delays: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
): number | undefined {
  return delays[Math.max(deliveryCount, 1) - 1];
}

/**
 * Function maxDeliveriesOf
 *
 * @description
 * Returns the delivery limit that goes with a list of retry delays: one first delivery, then one
 * redelivery per delay.
 *
 * @param {readonly number[]} delays - Delay after each failed delivery, in milliseconds.
 * @returns {number} The `max_deliver` of the durable consumer.
 */
export function maxDeliveriesOf(delays: readonly number[] = DEFAULT_RETRY_DELAYS_MS): number {
  return delays.length + 1;
}
