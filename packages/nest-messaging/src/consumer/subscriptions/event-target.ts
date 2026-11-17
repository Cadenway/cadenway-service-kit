import type { EventEnvelope } from '../../events/event-envelope.js';
import type { EventRoute } from '../../transport/event-route.js';
import type { EventContext } from '../delivery/event-context.js';

/**
 * Interface PreparedEvent
 *
 * @description
 * Holds a validated envelope together with the handler bound to its typed payload.
 */
export interface PreparedEvent {
  // #region Properties
  /**
   * Property envelope
   *
   * @description
   * Envelope used to scope and deduplicate the delivery.
   *
   * @type {EventEnvelope}
   * @readonly
   */
  readonly envelope: EventEnvelope;

  /**
   * Property handle
   *
   * @description
   * Invokes the registered handler with the result of schema validation.
   *
   * @type {(context: EventContext) => Promise<void>}
   * @readonly
   */
  readonly handle: (context: EventContext) => Promise<void>;
  // #endregion
}

/**
 * Interface EventTarget
 *
 * @description
 * Identifies a registered durable handler and prepares validated deliveries for it.
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
   * Property prepare
   *
   * @description
   * Validates a decoded message before binding it to the handler.
   *
   * @type {(candidate: unknown) => PreparedEvent}
   * @readonly
   */
  readonly prepare: (candidate: unknown) => PreparedEvent;
  // #endregion
}
