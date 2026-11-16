import type { VersionClaim } from '../event-deduplicator.js';

/**
 * Interface EventContext
 *
 * @description
 * What a handler receives next to the payload of an event.
 */
export interface EventContext {
  // #region Properties
  /**
   * Property deliveryCount
   *
   * @description
   * One-based number of this delivery to the consumer: 1 the first time, up to 5.
   *
   * @type {number}
   * @readonly
   */
  readonly deliveryCount: number;

  /**
   * Property streamSequence
   *
   * @description
   * Sequence of the message in its stream.
   *
   * @type {number}
   * @readonly
   */
  readonly streamSequence: number;

  /**
   * Property redelivered
   *
   * @description
   * `true` when the server delivered this message before.
   *
   * @type {boolean}
   * @readonly
   */
  readonly redelivered: boolean;

  /**
   * Property claimVersion
   *
   * @description
   * Tells whether to apply this event to an aggregate, by comparing the `version` of the event
   * with the last version this consumer applied to the given key in the organization of the
   * event. With the PostgreSQL deduplicator of `/outbox` a stale version resolves to `false` and
   * the claim is part of the transaction of the handler. Without a deduplicator there is no
   * version store and it always resolves to `true`.
   *
   * @type {VersionClaim}
   * @readonly
   */
  readonly claimVersion: VersionClaim;

  /**
   * Property signal
   *
   * @description
   * Aborted when the handler reaches `handlerTimeoutMs`. The attempt is then abandoned: pass the
   * signal to the calls the handler makes so that they stop too.
   *
   * @type {AbortSignal}
   * @readonly
   */
  readonly signal: AbortSignal;
  // #endregion
}
