import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type BeforeApplicationShutdown,
} from '@nestjs/common';

import { MessagingConnection } from '../connection/messaging-connection.js';
import type { EventNameOf, EventSchemas } from '../events/event-envelope.js';
import {
  MESSAGING_OPTIONS,
  type ResolvedMessagingOptions,
} from '../configuration/messaging-options.js';
import { MESSAGING_TUNING, type MessagingTuning } from '../configuration/messaging-tuning.js';
import type { RebuildSubscription } from '../rebuild/subscriptions/rebuild-subscription.js';
import { RebuildSubscriptions } from '../rebuild/subscriptions/rebuild-subscriptions.js';
import { EventDelivery } from './delivery/event-delivery.js';
import { EVENT_DEDUPLICATOR, type EventDeduplicator } from './delivery/event-deduplicator.js';
import { DurableSubscriptions } from './subscriptions/durable-subscriptions.js';
import type { EventSubscription } from './subscriptions/event-subscription.js';

export type { EventContext } from './delivery/event-context.js';
export type { EventSubscription } from './subscriptions/event-subscription.js';
export type { RebuildSubscription } from '../rebuild/subscriptions/rebuild-subscription.js';

/**
 * Class EventConsumers
 *
 * @description
 * Runs one durable pull consumer per event handler and one Core NATS subscription per rebuild.
 *
 * Each handler consumes one event through its own durable pull consumer, `<service>__<handler>`,
 * filtered on that event's subject. Delivery is at least once and unordered, with one active
 * delivery per handler per replica. A handler rejection or deadline uses the retry schedule.
 * Invalid payloads are terminated. Shutdown leaves deliveries that exceed the grace period
 * unacknowledged for redelivery.
 *
 * A consumer that disappears from the server (deleted, or lost with its stream) is reported to
 * readiness and recovered. When the module manages consumers, a missing consumer is created
 * again from the beginning of the retained stream. Otherwise, the kit waits for the platform.
 * Without a deduplicator, the handler runs for every delivery, including duplicates. Call
 * `subscribe` from a provider's `onApplicationBootstrap` to register it.
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
   * Property abandon
   *
   * @description
   * Cancels in-flight durable deliveries after the shutdown grace period.
   *
   * @type {AbortController}
   * @readonly
   */
  private readonly abandon: AbortController = new AbortController();

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
   * Shares the connection and shutdown deadline between durable and rebuild subscriptions.
   *
   * @param {MessagingConnection} connection - Connection shared by the durable event and rebuild paths.
   * @param {ResolvedMessagingOptions} options - Module routing, handler deadline and shutdown grace.
   * @param {MessagingTuning} tuning - Delivery retries and durable recovery timing.
   * @param {EventDeduplicator | undefined} deduplicator - Optional deduplicator that records effects before the acknowledgement.
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
      this.abandon.signal,
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
   * Registers a handler and starts pulling from its durable consumer. With `manageConsumers`
   * enabled, creates the consumer or updates its acknowledgement settings. Otherwise binds to
   * an existing consumer with the same filter.
   *
   * @param {EventSubscription<TSchemas, TName>} subscription - Event name and schemas, durable handler name and handler.
   * @returns {Promise<void>} Resolves once the durable consumer is present and the pull loop has started.
   * @throws {Error} When the handler is already registered, the application is closing or the
   * broker cannot supply the required consumer.
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
   * Registers a rebuild handler and waits for the broker to know the subscription. Replicas
   * share items through a queue group. The handler validates and applies one item at a time in
   * a context without an organization. Waiting items are evicted oldest first at the count or
   * byte limit, and oversized items are refused. Rebuild requests receive the outcome.
   *
   * @param {RebuildSubscription<TItem>} registration - Rebuilt entity name, item schema and handler.
   * @returns {Promise<void>} Resolves after the broker knows the subscription.
   * @throws {Error} When the application is closing, the entity is already registered or its
   * name cannot be a subject token.
   */
  public async onRebuild<TItem>(registration: RebuildSubscription<TItem>): Promise<void> {
    return this.rebuilds.onRebuild(registration);
  }

  /**
   * Method beforeApplicationShutdown
   *
   * @description
   * Stops pulling and lets the running handlers finish, for at most `shutdownTimeoutMs`. It runs
   * before the connection is drained and before the database pool closes. A durable handler
   * still running after the timeout receives an abort signal and leaves the message unacknowledged.
   *
   * @returns {Promise<void>} Resolves once handlers finish or shutdown grace expires.
   */
  public async beforeApplicationShutdown(): Promise<void> {
    this.stop.abort();
    const running: Promise<void>[] = [...this.subscriptions.close(), ...this.rebuilds.close()];
    let timer: NodeJS.Timeout | undefined;
    const timedOut: Promise<boolean> = new Promise<boolean>((resolve: (value: boolean) => void) => {
      timer = setTimeout(() => {
        this.abandon.abort();
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
