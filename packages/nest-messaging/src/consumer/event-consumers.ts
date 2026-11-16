import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type BeforeApplicationShutdown,
} from '@nestjs/common';

import { MessagingConnection } from '../connection/messaging-connection.js';
import type { EventNameOf, EventSchemas } from '../events/event-envelope.js';
import { MESSAGING_OPTIONS, type ResolvedMessagingOptions } from '../messaging-options.js';
import { MESSAGING_TUNING, type MessagingTuning } from '../messaging-tuning.js';
import type { RebuildSubscription } from '../rebuild/rebuild-subscription.js';
import { RebuildSubscriptions } from '../rebuild/rebuild-subscriptions.js';
import { EventDelivery } from './delivery/event-delivery.js';
import { EVENT_DEDUPLICATOR, type EventDeduplicator } from './event-deduplicator.js';
import { DurableSubscriptions } from './subscriptions/durable-subscriptions.js';
import type { EventSubscription } from './subscriptions/event-subscription.js';

export type { EventContext } from './delivery/event-context.js';
export type { EventSubscription } from './subscriptions/event-subscription.js';
export type { RebuildSubscription } from '../rebuild/rebuild-subscription.js';

/**
 * Class EventConsumers
 *
 * @description
 * Registers the event handlers of an application and runs them.
 *
 * Each handler consumes one event through its own durable pull consumer, `<service>__<handler>`,
 * filtered on the subject of that event: explicit acknowledgement, 30 seconds to handle a
 * message, five deliveries. Delivery is at least once and unordered. A handler that rejects or
 * passes `handlerTimeoutMs` is retried after 1 s, 5 s, 30 s and 2 min; after the fifth failure,
 * or when the payload does not match its contract, the message becomes a dead letter. One
 * message is handled at a time per handler and per replica.
 *
 * A consumer that disappears from the server (deleted, or lost with its stream) is reported to
 * readiness and recovered: created again when the module manages consumers, waited for
 * otherwise. Without an `EventDeduplicator` the handler runs for every delivery, duplicates
 * included; the outbox entry point provides the PostgreSQL deduplicator. Registration is
 * explicit: call `subscribe` from `onApplicationBootstrap` of a provider.
 */
@Injectable()
export class EventConsumers implements BeforeApplicationShutdown {
  // #region Properties
  /**
   * Property logger
   *
   * @description
   * Logger of the deliveries. It never receives a payload.
   *
   * @type {Logger}
   * @readonly
   */
  private readonly logger: Logger = new Logger('EventConsumers');

  /**
   * Property stop
   *
   * @description
   * Aborted when the application shuts down: no new registration, the recoveries stop waiting,
   * and a pull loop that ends is expected.
   *
   * @type {AbortController}
   * @readonly
   */
  private readonly stop: AbortController = new AbortController();

  /**
   * Property subscriptions
   *
   * @description
   * Registers durable event handlers and manages their pull loops.
   *
   * @type {DurableSubscriptions}
   * @readonly
   */
  private readonly subscriptions: DurableSubscriptions;

  /**
   * Property rebuilds
   *
   * @description
   * Registers and closes the receivers of rebuild items.
   *
   * @type {RebuildSubscriptions}
   * @readonly
   */
  private readonly rebuilds: RebuildSubscriptions;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Shares the module's connection, logger and shutdown signal between the event and rebuild paths.
   *
   * @param {MessagingConnection} connection - NATS connection of the application.
   * @param {ResolvedMessagingOptions} options - Options of the module.
   * @param {MessagingTuning} tuning - Retry and recovery timings.
   * @param {EventDeduplicator | undefined} deduplicator - Deduplicator of the application, when it has one.
   * @constructor
   */
  public constructor(
    connection: MessagingConnection,
    @Inject(MESSAGING_OPTIONS) private readonly options: ResolvedMessagingOptions,
    @Inject(MESSAGING_TUNING) tuning: MessagingTuning,
    @Optional() @Inject(EVENT_DEDUPLICATOR) deduplicator?: EventDeduplicator,
  ) {
    const delivery: EventDelivery = new EventDelivery(
      this.logger,
      options.handlerTimeoutMs,
      tuning.retryDelaysMs,
      deduplicator,
    );
    this.subscriptions = new DurableSubscriptions(
      connection,
      options,
      tuning,
      this.logger,
      this.stop.signal,
      delivery,
    );
    this.rebuilds = new RebuildSubscriptions(connection, options, this.logger, this.stop.signal);
  }
  // #endregion

  // #region Methods
  /**
   * Method subscribe
   *
   * @description
   * Registers a handler for one event and starts delivering to it. With `manageConsumers` on,
   * the durable consumer is created, or its acknowledgement settings updated; otherwise the
   * handler binds to the existing consumer.
   *
   * @param {EventSubscription<TSchemas, TName>} subscription - Handler name, event and handler.
   * @returns {Promise<void>} Resolves once the consumer exists and is being pulled.
   * @throws {Error} When the handler is already registered, the stream is missing, the consumer is missing while `manageConsumers` is off, the server refuses to create or update it, or it filters another subject.
   */
  public async subscribe<TSchemas extends EventSchemas, TName extends EventNameOf<TSchemas>>(
    subscription: EventSubscription<TSchemas, TName>,
  ): Promise<void> {
    return this.subscriptions.subscribe(subscription);
  }

  /**
   * Method onRebuild
   *
   * @description
   * Registers the handler of a rebuilt entity: items the owner of the entity emits on
   * `rebuild.<rebuildName>.<entity>` (the NATS user of this application by default) are
   * validated and applied one at a time, in a context without organization; an item sent as a
   * request is answered. Replicas share the items through a queue group. When more than
   * `rebuildMaxPending` items wait, the oldest ones are dropped with an error log.
   *
   * @param {RebuildSubscription<TItem>} registration - Entity, item schema and handler.
   * @returns {Promise<void>} Resolves once the server knows the subscription: an emitter that starts afterwards finds the consumer.
   * @throws {Error} When the entity is already registered or its name cannot be a subject token.
   */
  public async onRebuild<TItem>(registration: RebuildSubscription<TItem>): Promise<void> {
    return this.rebuilds.onRebuild(registration);
  }

  /**
   * Method beforeApplicationShutdown
   *
   * @description
   * Stops pulling and lets the running handlers finish, for at most `shutdownTimeoutMs`. It runs
   * before the connection is drained and before the database pool closes. A handler still
   * running after the timeout is abandoned: its message is redelivered later.
   *
   * @returns {Promise<void>} Resolves once the handlers finished or the timeout elapsed.
   */
  public async beforeApplicationShutdown(): Promise<void> {
    this.stop.abort();
    const running: Promise<void>[] = [...this.subscriptions.close(), ...this.rebuilds.close()];
    let timer: NodeJS.Timeout | undefined;
    const timedOut: Promise<boolean> = new Promise<boolean>((resolve: (value: boolean) => void) => {
      timer = setTimeout(() => {
        resolve(true);
      }, this.options.shutdownTimeoutMs);
    });
    const finished: Promise<boolean> = Promise.allSettled(running).then(() => false);
    if (await Promise.race([finished, timedOut])) {
      this.logger.warn(
        { timeoutMs: this.options.shutdownTimeoutMs },
        'handlers still running at shutdown were abandoned',
      );
    }
    clearTimeout(timer);
  }
  // #endregion
}
