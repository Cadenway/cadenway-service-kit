import type { EventNameOf, EventPayloadOf, EventSchemas } from '../../events/event-envelope.js';
import type { EventContext } from '../delivery/event-context.js';
import type { EventRedelivery } from './event-redelivery.js';

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
   * holds, `new` only what is published afterwards. Defaults to `all`. An existing consumer keeps
   * its position. If the kit recreates a missing consumer during recovery, it replays from the
   * beginning of the retained stream so it can recover deliveries made to other replicas.
   *
   * @type {'all' | 'new' | undefined}
   * @readonly
   */
  readonly deliverPolicy?: 'all' | 'new';

  /**
   * Property redelivery
   *
   * @description
   * Redelivery schedule of this handler: the delays between the deliveries of a failing message
   * and the number of deliveries before its dead letter. Without it, the handler gets the default
   * schedule (1 s, 5 s, 30 s, 2 min, five deliveries). `subscribe` rejects a schedule that
   * JetStream or the retention of the stream cannot honor (see `EventRedelivery`). The kit sets
   * the delivery limit on the durable consumer it manages, updating an existing one in place;
   * with `manageConsumers` off, the consumer created elsewhere must already have that limit.
   *
   * @type {EventRedelivery | undefined}
   * @readonly
   */
  readonly redelivery?: EventRedelivery;

  /**
   * Property handle
   *
   * @description
   * Receives the validated schema output in the event's organization context. A success is
   * acknowledged after any deduplication transaction commits. A rejection uses the retry
   * schedule. Handlers must be idempotent and honor `context.signal` when their deadline or
   * shutdown grace expires.
   *
   * @type {( payload: EventPayloadOf<TSchemas, TName>, context: EventContext, ) => Promise<void>}
   * @readonly
   */
  readonly handle: (
    payload: EventPayloadOf<TSchemas, TName>,
    context: EventContext,
  ) => Promise<void>;
  // #endregion
}
