/**
 * Interface EventRedelivery
 *
 * @description
 * Redelivery schedule of one handler, which replaces the default one (1 s, 5 s, 30 s, 2 min,
 * five deliveries) for that handler only. The kit applies it with `nak(delay)`: the durable
 * consumer keeps its 30-second `AckWait` and gets no server-side `BackOff`, whose first entry
 * would replace the acknowledgement wait. A message whose last allowed delivery fails reaches the
 * consumer's `max_deliver`, and the dead-letter worker copies it to the dead-letter stream.
 *
 * `subscribe` checks the schedule before any broker request and rejects it, failing the start-up:
 *
 * - every delay is a whole number of milliseconds from 1;
 * - `maxDeliveries` is a whole number above the number of delays, as JetStream requires
 *   `max_deliver` to exceed the length of a `BackOff` list: a delay that can never be used is a
 *   mistake;
 * - an empty list allows a single delivery only;
 * - the whole schedule, counting the delays and an acknowledgement wait for every delivery, ends
 *   before the stream drops the message: seven days for `EVENTS` and one hour for
 *   `EVENTS_RESTRICTED`, as cadenway-ops keeps them. A message dropped while it waits for a
 *   redelivery would be lost without a dead letter.
 *
 * A delivery that is never answered, because its replica crashed, is redelivered by the server
 * after the 30-second acknowledgement wait rather than after the scheduled delay, and counts
 * towards `maxDeliveries`.
 */
export interface EventRedelivery {
  // #region Properties
  /**
   * Property delaysMs
   *
   * @description
   * Delay before each redelivery, in milliseconds: the first failed delivery waits the first
   * delay, and so on. When `maxDeliveries` allows more redeliveries than there are delays, the
   * last delay repeats.
   *
   * @type {readonly number[]}
   * @readonly
   */
  readonly delaysMs: readonly number[];

  /**
   * Property maxDeliveries
   *
   * @description
   * Number of deliveries, the first one included, after which a failing message becomes a dead
   * letter: the `max_deliver` of the durable consumer. Defaults to one more than the number of
   * delays.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly maxDeliveries?: number;
  // #endregion
}
