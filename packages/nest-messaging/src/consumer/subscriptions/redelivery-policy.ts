import {
  ACK_WAIT_MS,
  EVENTS_MAX_AGE_DAYS,
  RESTRICTED_MAX_AGE_MS,
} from '../../configuration/messaging-defaults.js';
import type { EventRoute } from '../../transport/event-route.js';
import { maxDeliveriesOf, retryDelayMs } from '../delivery/retry-delays.js';
import type { EventRedelivery } from './event-redelivery.js';

/**
 * Constant DAY_MS
 *
 * @description
 * One day, in milliseconds.
 *
 * @type {number}
 */
const DAY_MS: number = 86_400_000;

/**
 * Interface RedeliveryPolicy
 *
 * @description
 * Redelivery schedule of one registered handler, checked and complete: the delays the delivery
 * path waits between attempts and the `max_deliver` of its durable consumer.
 */
export interface RedeliveryPolicy {
  // #region Properties
  /**
   * Property delaysMs
   *
   * @description
   * Delay before each redelivery, in milliseconds; the last one repeats up to `maxDeliveries`.
   *
   * @type {readonly number[]}
   * @readonly
   */
  readonly delaysMs: readonly number[];

  /**
   * Property maxDeliveries
   *
   * @description
   * Number of deliveries, the first one included, before the message becomes a dead letter.
   *
   * @type {number}
   * @readonly
   */
  readonly maxDeliveries: number;

  /**
   * Property custom
   *
   * @description
   * Whether the registration set its own schedule. Only a custom schedule is checked against a
   * consumer the kit does not manage, so the default path behaves as before.
   *
   * @type {boolean}
   * @readonly
   */
  readonly custom: boolean;
  // #endregion
}

/**
 * Function retentionOf
 *
 * @description
 * How long the stream of a route keeps a message, as cadenway-ops and `manageStreams` create it.
 *
 * @param {EventRoute} route - Stream and subject of the event.
 * @returns {number} The retention, in milliseconds.
 */
function retentionOf(route: EventRoute): number {
  return route.restricted ? RESTRICTED_MAX_AGE_MS : EVENTS_MAX_AGE_DAYS * DAY_MS;
}

/**
 * Function scheduleSpanMs
 *
 * @description
 * Longest time between the publication of a message and the end of its last allowed delivery:
 * every redelivery delay, plus one acknowledgement wait per delivery, the longest an attempt can
 * hold the message.
 *
 * @param {readonly number[]} delaysMs - Delay before each redelivery, in milliseconds.
 * @param {number} maxDeliveries - Delivery limit.
 * @returns {number} The span, in milliseconds.
 */
function scheduleSpanMs(delaysMs: readonly number[], maxDeliveries: number): number {
  let span: number = maxDeliveries * ACK_WAIT_MS;
  for (let failed: number = 1; failed < maxDeliveries; failed += 1) {
    span += retryDelayMs(failed, delaysMs, maxDeliveries) ?? 0;
  }
  return span;
}

/**
 * Function resolveRedelivery
 *
 * @description
 * Builds the redelivery policy of a registration: the default schedule when it sets none,
 * otherwise its own, checked before any broker request.
 *
 * @param {string} consumer - Name of the durable consumer, quoted by the errors.
 * @param {EventRedelivery | undefined} redelivery - Schedule of the registration, if any.
 * @param {readonly number[]} defaultDelaysMs - Default delays of the application.
 * @param {EventRoute} route - Stream and subject of the event, which set the retention limit.
 * @returns {RedeliveryPolicy} The policy of the handler.
 * @throws {Error} When a delay is not a whole number of milliseconds from 1, the delivery limit is
 * not a whole number above the number of delays, an empty list allows more than one delivery, or
 * the schedule outlasts the retention of the stream.
 */
export function resolveRedelivery(
  consumer: string,
  redelivery: EventRedelivery | undefined,
  defaultDelaysMs: readonly number[],
  route: EventRoute,
): RedeliveryPolicy {
  if (redelivery === undefined) {
    return {
      delaysMs: defaultDelaysMs,
      maxDeliveries: maxDeliveriesOf(defaultDelaysMs),
      custom: false,
    };
  }
  const delaysMs: unknown = redelivery.delaysMs;
  if (
    !Array.isArray(delaysMs) ||
    !delaysMs.every((delay: unknown) => Number.isSafeInteger(delay) && (delay as number) >= 1)
  ) {
    throw new Error(
      `The redelivery delays of ${consumer} are whole numbers of milliseconds from 1.`,
    );
  }
  const delays: readonly number[] = Object.freeze([...(delaysMs as number[])]);
  const maxDeliveries: number = redelivery.maxDeliveries ?? maxDeliveriesOf(delays);
  if (!Number.isSafeInteger(maxDeliveries) || maxDeliveries < 1) {
    throw new Error(`The maxDeliveries of ${consumer} is a whole number from 1.`);
  }
  if (delays.length === 0 && maxDeliveries > 1) {
    throw new Error(
      `The redelivery of ${consumer} allows ${String(maxDeliveries)} deliveries without a delay: give at least one delay.`,
    );
  }
  if (maxDeliveries <= delays.length) {
    throw new Error(
      `The maxDeliveries of ${consumer} (${String(maxDeliveries)}) must exceed its ${String(delays.length)} redelivery delays, as JetStream requires max_deliver to exceed a backoff list: the last delays would never be used.`,
    );
  }
  const span: number = scheduleSpanMs(delays, maxDeliveries);
  const retention: number = retentionOf(route);
  if (span >= retention) {
    throw new Error(
      `The redelivery of ${consumer} can last ${String(span)} ms, counting a ${String(ACK_WAIT_MS)} ms acknowledgement wait per delivery, but the stream ${route.stream} keeps a message ${String(retention)} ms: the message would be dropped before its dead letter.`,
    );
  }
  return { delaysMs: delays, maxDeliveries, custom: true };
}
