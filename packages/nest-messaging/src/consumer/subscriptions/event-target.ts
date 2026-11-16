import type { EventEnvelope } from '../../events/event-envelope.js';
import type { EventRoute } from '../../messaging-options.js';
import type { EventContext } from '../delivery/event-context.js';

/**
 * Interface EventTarget
 *
 * @description
 * One registered event handler, with its types erased.
 */
export interface EventTarget {
  // #region Properties
  /**
   * Property consumer
   *
   * @description
   * Name of the durable consumer.
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
   * Property route
   *
   * @description
   * Subject and stream of the event.
   *
   * @type {EventRoute}
   * @readonly
   */
  readonly route: EventRoute;

  /**
   * Property deliverPolicy
   *
   * @description
   * Start position of a consumer created by this registration.
   *
   * @type {'all' | 'new'}
   * @readonly
   */
  readonly deliverPolicy: 'all' | 'new';

  /**
   * Property validate
   *
   * @description
   * Validates a decoded message with the schema of the event.
   *
   * @type {(candidate: unknown) => EventEnvelope}
   * @readonly
   */
  readonly validate: (candidate: unknown) => EventEnvelope;

  /**
   * Property handle
   *
   * @description
   * Handler of the event.
   *
   * @type {(payload: EventEnvelope, context: EventContext) => Promise<void>}
   * @readonly
   */
  readonly handle: (payload: EventEnvelope, context: EventContext) => Promise<void>;
  // #endregion
}
