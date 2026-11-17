import { DEFAULT_RETRY_DELAYS_MS } from '../consumer/delivery/retry-delays.js';

/**
 * Constant MESSAGING_TUNING
 *
 * @description
 * Injection token of the timings the platform relies on and an application never changes. It is
 * internal to the package: specs override it with `overrideProvider` because they cannot wait
 * two minutes for a redelivery.
 *
 * @type {unique symbol}
 */
export const MESSAGING_TUNING: unique symbol = Symbol('cadenway.messaging.tuning');

/**
 * Interface MessagingTuning
 *
 * @description
 * Timings provided under `MESSAGING_TUNING`.
 */
export interface MessagingTuning {
  // #region Properties
  /**
   * Property retryDelaysMs
   *
   * @description
   * Delay before each redelivery of an event whose handler failed, in milliseconds: 1 s, 5 s,
   * 30 s and 2 min. Their count plus one is the `max_deliver` of every durable consumer.
   *
   * @type {readonly number[]}
   * @readonly
   */
  readonly retryDelaysMs: readonly number[];

  /**
   * Property deadLetterRetryDelaysMs
   *
   * @description
   * Delays between the attempts to store one dead letter, in milliseconds: five attempts over
   * about two minutes.
   *
   * @type {readonly number[]}
   * @readonly
   */
  readonly deadLetterRetryDelaysMs: readonly number[];

  /**
   * Property consumerRecoveryDelaysMs
   *
   * @description
   * Delays between the attempts to recover a durable consumer that disappeared, in
   * milliseconds; the last one repeats.
   *
   * @type {readonly number[]}
   * @readonly
   */
  readonly consumerRecoveryDelaysMs: readonly number[];

  /**
   * Property claimLockTimeoutMs
   *
   * @description
   * Time the PostgreSQL deduplicator waits for the processed id of an event another delivery is
   * still handling, in milliseconds.
   *
   * @type {number}
   * @readonly
   */
  readonly claimLockTimeoutMs: number;
  // #endregion
}

/**
 * Constant DEFAULT_MESSAGING_TUNING
 *
 * @description
 * Timings of production.
 *
 * @type {MessagingTuning}
 */
export const DEFAULT_MESSAGING_TUNING: MessagingTuning = {
  retryDelaysMs: DEFAULT_RETRY_DELAYS_MS,
  deadLetterRetryDelaysMs: [5000, 10_000, 30_000, 60_000],
  consumerRecoveryDelaysMs: [0, 1000, 2000, 5000, 10_000, 30_000],
  claimLockTimeoutMs: 5000,
};
