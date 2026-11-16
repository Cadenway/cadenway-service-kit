import type { EventNameOf, EventPayloadOf, EventSchemas } from '../../events/event-envelope.js';
import type { EventContext } from '../delivery/event-context.js';

/**
 * Interface EventSubscription
 *
 * @description
 * Registration of one handler for one event.
 */
export interface EventSubscription<
  TSchemas extends EventSchemas,
  TName extends EventNameOf<TSchemas>,
> {
  // #region Properties
  /**
   * Property handler
   *
   * @description
   * Name of the handler inside the service, such as `index-task`. The durable consumer is named
   * `<service>__<handler>`: renaming a handler creates a new consumer. Letters, digits, hyphens
   * and underscores only.
   *
   * @type {string}
   * @readonly
   */
  readonly handler: string;

  /**
   * Property schemas
   *
   * @description
   * `eventSchemas` object of the event module of `@cadenway/contracts` that defines the event.
   *
   * @type {TSchemas}
   * @readonly
   */
  readonly schemas: TSchemas;

  /**
   * Property event
   *
   * @description
   * Name of the one event the handler consumes.
   *
   * @type {TName}
   * @readonly
   */
  readonly event: TName;

  /**
   * Property deliverPolicy
   *
   * @description
   * Where a consumer created by this registration starts: `all` delivers what the stream still
   * holds, `new` only what is published afterwards. Defaults to `all`. Ignored once the consumer
   * exists, except when it is created again after it disappeared: see the README.
   *
   * @type {'all' | 'new' | undefined}
   * @readonly
   */
  readonly deliverPolicy?: 'all' | 'new';

  /**
   * Property handle
   *
   * @description
   * Handler of the event. It runs inside the organization context of the event and a consumer
   * span. Resolving acknowledges the message; rejecting schedules a redelivery. It must be
   * idempotent and finish within `handlerTimeoutMs`, after which the attempt is abandoned.
   *
   * @type {(payload: EventPayloadOf<TSchemas, TName>, context: EventContext) => Promise<void>}
   * @readonly
   */
  readonly handle: (
    payload: EventPayloadOf<TSchemas, TName>,
    context: EventContext,
  ) => Promise<void>;
  // #endregion
}
