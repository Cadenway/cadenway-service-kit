import type { EventEnvelope } from '../events/event-envelope.js';

/**
 * Constant EVENT_DEDUPLICATOR
 *
 * @description
 * Injection token of the optional `EventDeduplicator` of an application. `OutboxModule` of
 * `@cadenway/nest-messaging/outbox` provides the PostgreSQL one; without any, every delivery
 * reaches the handler.
 *
 * @type {symbol}
 */
export const EVENT_DEDUPLICATOR: unique symbol = Symbol('cadenway.messaging.deduplicator');

/**
 * Type VersionClaim
 *
 * @description
 * Function a handler calls to learn whether the event it received is newer than what it already
 * applied to an aggregate. It resolves to `true` when the handler should apply the event and
 * `false` when a newer or equal version was applied before.
 *
 * @type {(aggregateKey: string) => Promise<boolean>}
 */
export type VersionClaim = (aggregateKey: string) => Promise<boolean>;

/**
 * Type DeduplicationOutcome
 *
 * @description
 * What a deduplicator did with a delivery: it ran the handler, or it skipped it because the
 * event had already been processed by this consumer.
 *
 * @type {'handled' | 'duplicate'}
 */
export type DeduplicationOutcome = 'handled' | 'duplicate';

/**
 * Interface EventDelivery
 *
 * @description
 * One delivery of an event to a durable consumer, as a deduplicator sees it.
 */
export interface EventDelivery {
  // #region Properties
  /**
   * Property consumer
   *
   * @description
   * Name of the durable consumer, `<service>__<handler>`: the scope of the deduplication.
   *
   * @type {string}
   * @readonly
   */
  readonly consumer: string;

  /**
   * Property event
   *
   * @description
   * Name of the event.
   *
   * @type {string}
   * @readonly
   */
  readonly event: string;

  /**
   * Property envelope
   *
   * @description
   * Validated payload of the event: its id, organization, actor and version.
   *
   * @type {EventEnvelope}
   * @readonly
   */
  readonly envelope: EventEnvelope;
  // #endregion
}

/**
 * Interface EventDeduplicator
 *
 * @description
 * Wraps the call of an event handler so that an event already processed by a consumer is not
 * handled twice. The consumers call it inside the organization context of the event.
 *
 * An implementation records the event id and runs the handler atomically: when the handler
 * fails, the id is not recorded and the redelivery runs the handler again.
 */
export interface EventDeduplicator {
  // #region Methods
  /**
   * Method run
   *
   * @description
   * Runs the handler unless this consumer already processed the event.
   *
   * @param {EventDelivery} delivery - Consumer, event name and validated envelope.
   * @param {(claimVersion: VersionClaim) => Promise<void>} handle - Calls the handler; it receives the version claim to expose in the handler context.
   * @returns {Promise<DeduplicationOutcome>} `handled` once the handler succeeded, `duplicate` when it was skipped. It rejects when the handler fails.
   */
  run(
    delivery: EventDelivery,
    handle: (claimVersion: VersionClaim) => Promise<void>,
  ): Promise<DeduplicationOutcome>;
  // #endregion
}
