import { runWithOrganizationContext } from '@cadenway/nest-common';
import {
  AckPolicy,
  DeliverPolicy,
  JetStreamApiCodes,
  JetStreamApiError,
  type Consumer,
  type ConsumerInfo,
  type ConsumerMessages,
  type JetStreamManager,
  type JsMsg,
} from '@nats-io/jetstream';
import { nanos, type Msg, type Subscription } from '@nats-io/transport-node';
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import {
  context,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
} from '@opentelemetry/api';
import type { z } from 'zod';

import { isJetStreamApiError, MessagingConnection } from '../connection/messaging-connection.js';
import type {
  EventEnvelope,
  EventNameOf,
  EventPayloadOf,
  EventSchemas,
} from '../events/event-envelope.js';
import { EventValidationError, validateEvent } from '../events/event-validation.js';
import {
  ACK_WAIT_MS,
  eventRoute,
  MESSAGING_OPTIONS,
  type EventRoute,
  type ResolvedMessagingOptions,
} from '../messaging-options.js';
import { contextFromTraceparent, TRACEPARENT_HEADER } from '../publisher/event-headers.js';
import { encodeRebuildReply } from '../rebuild/rebuild-emitter.js';
import { durableConsumerName, rebuildSubject } from '../subjects.js';
import {
  EVENT_DEDUPLICATOR,
  type DeduplicationOutcome,
  type EventDeduplicator,
  type VersionClaim,
} from './event-deduplicator.js';
import { maxDeliveriesOf, retryDelayMs } from './retry-delays.js';

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
   * Sequence of the message in the events stream.
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
   * with the last version this consumer applied to the given key. With the PostgreSQL
   * deduplicator of `/outbox` a stale version resolves to `false` and the claim is part of the
   * transaction of the handler. Without a deduplicator there is no version store and it always
   * resolves to `true`.
   *
   * @type {VersionClaim}
   * @readonly
   */
  readonly claimVersion: VersionClaim;
  // #endregion
}

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
   * exists.
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
   * idempotent and finish within 30 seconds, after which the server redelivers the message.
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

/**
 * Interface RebuildSubscription
 *
 * @description
 * Registration of the handler of one rebuilt entity.
 */
export interface RebuildSubscription<TItem> {
  // #region Properties
  /**
   * Property entity
   *
   * @description
   * Name of the entity, such as `task`: the last token of `rebuild.<this service>.<entity>`.
   *
   * @type {string}
   * @readonly
   */
  readonly entity: string;

  /**
   * Property schema
   *
   * @description
   * Zod schema of an item. An item that does not match is refused and its emitter is told.
   *
   * @type {z.ZodType<TItem>}
   * @readonly
   */
  readonly schema: z.ZodType<TItem>;

  /**
   * Property handle
   *
   * @description
   * Applies one item. It runs outside any organization context: it opens the transaction it
   * needs itself. It must be idempotent, since a rebuild may be started again.
   *
   * @type {(item: TItem) => Promise<void>}
   * @readonly
   */
  readonly handle: (item: TItem) => Promise<void>;
  // #endregion
}

/**
 * Interface EventTarget
 *
 * @description
 * One registered event handler, with its types erased.
 */
interface EventTarget {
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

/**
 * Interface RunningConsumer
 *
 * @description
 * A durable consumer being pulled.
 */
interface RunningConsumer {
  // #region Properties
  /**
   * Property messages
   *
   * @description
   * Pull loop of the client; closing it stops pulling.
   *
   * @type {ConsumerMessages}
   * @readonly
   */
  readonly messages: ConsumerMessages;

  /**
   * Property done
   *
   * @description
   * Resolves when the last handler call returned.
   *
   * @type {Promise<void>}
   * @readonly
   */
  readonly done: Promise<void>;
  // #endregion
}

/**
 * Interface RunningRebuild
 *
 * @description
 * A rebuild subscription being served.
 */
interface RunningRebuild {
  // #region Properties
  /**
   * Property subscription
   *
   * @description
   * Core NATS subscription on the rebuild subject.
   *
   * @type {Subscription}
   * @readonly
   */
  readonly subscription: Subscription;

  /**
   * Property done
   *
   * @description
   * Resolves when the last handler call returned.
   *
   * @type {Promise<void>}
   * @readonly
   */
  readonly done: Promise<void>;
  // #endregion
}

/**
 * Function alwaysApply
 *
 * @description
 * Version claim of an application without a deduplicator: there is no version store, so every
 * event is applied.
 *
 * @returns {Promise<boolean>} Always `true`.
 */
function alwaysApply(): Promise<boolean> {
  return Promise.resolve(true);
}

/**
 * Class EventConsumers
 *
 * @description
 * Registers the event handlers of an application and runs them.
 *
 * Each handler consumes one event through its own durable pull consumer, `<service>__<handler>`,
 * filtered on the subject of that event: explicit acknowledgement, 30 seconds to handle a
 * message, five deliveries. Delivery is at least once and unordered. A handler that rejects is
 * retried after 1 s, 5 s, 30 s and 2 min; after the fifth failure, or when the payload does not
 * match its contract, the message becomes a dead letter. One message is handled at a time per
 * handler and per replica.
 *
 * Without an `EventDeduplicator` the handler runs for every delivery, duplicates included; the
 * outbox entry point provides the PostgreSQL deduplicator. Registration is explicit: call
 * `subscribe` from `onApplicationBootstrap` of a provider.
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
   * Property consumers
   *
   * @description
   * Durable consumers being pulled, by name.
   *
   * @type {Map<string, RunningConsumer>}
   * @readonly
   */
  private readonly consumers: Map<string, RunningConsumer> = new Map<string, RunningConsumer>();

  /**
   * Property rebuilds
   *
   * @description
   * Rebuild subscriptions being served, by subject.
   *
   * @type {Map<string, RunningRebuild>}
   * @readonly
   */
  private readonly rebuilds: Map<string, RunningRebuild> = new Map<string, RunningRebuild>();

  /**
   * Property stopping
   *
   * @description
   * Set when the application shuts down: no new registration, and a pull loop that ends is
   * expected.
   *
   * @type {boolean}
   */
  private stopping: boolean = false;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Stores the connection, the options and the deduplicator when the application provides one.
   *
   * @param {MessagingConnection} connection - NATS connection of the application.
   * @param {ResolvedMessagingOptions} options - Options of the module.
   * @param {EventDeduplicator | undefined} deduplicator - Deduplicator of the application, when it has one.
   * @constructor
   */
  public constructor(
    private readonly connection: MessagingConnection,
    @Inject(MESSAGING_OPTIONS) private readonly options: ResolvedMessagingOptions,
    @Optional() @Inject(EVENT_DEDUPLICATOR) private readonly deduplicator?: EventDeduplicator,
  ) {}
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
   * @throws {Error} When the handler is already registered, the stream is missing, the consumer is missing while `manageConsumers` is off, or the consumer filters another subject.
   */
  public async subscribe<TSchemas extends EventSchemas, TName extends EventNameOf<TSchemas>>(
    subscription: EventSubscription<TSchemas, TName>,
  ): Promise<void> {
    if (this.stopping) {
      throw new Error('The application is shutting down: no handler can be registered.');
    }
    const name: string = durableConsumerName(this.options.service, subscription.handler);
    if (this.consumers.has(name)) {
      throw new Error(`The handler ${subscription.handler} is already registered.`);
    }
    const route: EventRoute = eventRoute(this.options, subscription.event);
    const subject: string = route.subject;
    const target: EventTarget = {
      consumer: name,
      event: subscription.event,
      validate: (candidate: unknown): EventEnvelope =>
        validateEvent(subscription.schemas, subscription.event, candidate),
      handle: (payload: EventEnvelope, eventContext: EventContext): Promise<void> =>
        subscription.handle(payload as EventPayloadOf<TSchemas, TName>, eventContext),
    };
    const consumer: Consumer = await this.openConsumer(
      name,
      route,
      subscription.deliverPolicy ?? 'all',
    );
    // One message at a time: nothing waits in a client buffer while its acknowledgement clock
    // runs on the server.
    const messages: ConsumerMessages = await consumer.consume({ max_messages: 1 });
    void this.logNotifications(name, messages);
    this.consumers.set(name, { messages, done: this.pump(target, messages) });
    this.logger.log({ consumer: name, stream: route.stream, subject }, 'event consumer started');
  }

  /**
   * Method onRebuild
   *
   * @description
   * Registers the handler of a rebuilt entity: items the owner of the entity emits on
   * `rebuild.<rebuildName>.<entity>` (the NATS user of this application by default) are
   * validated and applied one at a time; an item sent as a request is answered. Replicas share
   * the items through a queue group.
   *
   * @param {RebuildSubscription<TItem>} registration - Entity, item schema and handler.
   * @returns {Promise<void>} Resolves once the server knows the subscription: an emitter that starts afterwards finds the consumer.
   * @throws {Error} When the entity is already registered or its name cannot be a subject token.
   */
  public async onRebuild<TItem>(registration: RebuildSubscription<TItem>): Promise<void> {
    if (this.stopping) {
      throw new Error('The application is shutting down: no handler can be registered.');
    }
    const subject: string = rebuildSubject(
      this.options.rebuildSubjectPrefix,
      this.options.rebuildName,
      registration.entity,
    );
    if (this.rebuilds.has(subject)) {
      throw new Error(`The rebuild of ${registration.entity} is already registered.`);
    }
    const subscription: Subscription = this.connection.nats.subscribe(subject, {
      queue: this.options.rebuildName,
    });
    this.rebuilds.set(subject, {
      subscription,
      done: this.serveRebuild(subject, subscription, registration),
    });
    await this.connection.flush();
    this.logger.log({ subject }, 'rebuild handler started');
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
    this.stopping = true;
    const running: Promise<void>[] = [];
    for (const consumer of this.consumers.values()) {
      running.push(consumer.done);
      void consumer.messages.close();
    }
    for (const rebuild of this.rebuilds.values()) {
      running.push(rebuild.done);
      rebuild.subscription.unsubscribe();
    }
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

  /**
   * Method openConsumer
   *
   * @description
   * Returns the durable consumer of a handler, after creating or updating it when the module
   * manages consumers, and checks that it filters the expected subject. It reads the consumer
   * with `$JS.API.CONSUMER.INFO.<stream>.<name>` and never lists nor deletes consumers.
   *
   * @param {string} name - Name of the durable consumer.
   * @param {EventRoute} route - Subject and stream of the event.
   * @param {'all' | 'new'} deliverPolicy - Start position of a consumer created here.
   * @returns {Promise<Consumer>} The consumer, ready to be pulled.
   */
  private async openConsumer(
    name: string,
    route: EventRoute,
    deliverPolicy: 'all' | 'new',
  ): Promise<Consumer> {
    const stream: string = route.stream;
    try {
      if (this.options.manageConsumers) {
        await this.ensureConsumer(name, route, deliverPolicy);
      }
      const consumer: Consumer = await this.connection.jetstream.consumers.get(stream, name);
      const info: ConsumerInfo = await consumer.info(true);
      if (info.config.filter_subject !== route.subject) {
        throw new Error(
          `The consumer ${name} of the stream ${stream} does not filter ${route.subject}: a handler consumes exactly one event. Rename the handler to consume another event.`,
        );
      }
      return consumer;
    } catch (error) {
      if (isJetStreamApiError(error, JetStreamApiCodes.StreamNotFound)) {
        throw new Error(
          `The stream ${stream} does not exist: the streams are created by cadenway-ops, or by MessagingModule with manageStreams in local tests.`,
          { cause: error },
        );
      }
      if (isJetStreamApiError(error, JetStreamApiCodes.ConsumerNotFound)) {
        throw new Error(
          `The durable consumer ${name} does not exist on the stream ${stream}: with manageConsumers off it is created by the platform.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  /**
   * Method ensureConsumer
   *
   * @description
   * Creates the durable pull consumer of a handler, or aligns the acknowledgement wait and the
   * delivery limit of an existing one, through `$JS.API.CONSUMER.CREATE.<stream>.<name>.<filter>`.
   * No server-side backoff is set: its first entry would replace the acknowledgement wait.
   *
   * The kit never deletes a consumer: when the server refuses the creation or the update, for
   * instance because a field that cannot change differs, it fails with an error naming the
   * consumer, and an operator removes the obsolete consumer.
   *
   * @param {string} name - Name of the durable consumer.
   * @param {EventRoute} route - Subject of the event, the single filter of the consumer, and its stream.
   * @param {'all' | 'new'} deliverPolicy - Start position of a new consumer.
   * @returns {Promise<void>} Resolves once the consumer exists with the expected settings.
   * @throws {Error} When the server refuses to create or update the consumer.
   */
  private async ensureConsumer(
    name: string,
    route: EventRoute,
    deliverPolicy: 'all' | 'new',
  ): Promise<void> {
    const stream: string = route.stream;
    const manager: JetStreamManager = await this.connection.manager();
    const ackWait: number = nanos(ACK_WAIT_MS);
    const maxDeliver: number = maxDeliveriesOf(this.options.retryDelaysMs);
    let existing: ConsumerInfo | undefined;
    try {
      existing = await manager.consumers.info(stream, name);
    } catch (error) {
      if (!isJetStreamApiError(error, JetStreamApiCodes.ConsumerNotFound)) {
        throw error;
      }
    }
    try {
      if (existing === undefined) {
        await manager.consumers.add(stream, {
          durable_name: name,
          name,
          filter_subject: route.subject,
          ack_policy: AckPolicy.Explicit,
          ack_wait: ackWait,
          max_deliver: maxDeliver,
          deliver_policy: deliverPolicy === 'new' ? DeliverPolicy.New : DeliverPolicy.All,
        });
        return;
      }
      if (
        existing.config.filter_subject === route.subject &&
        (existing.config.ack_wait !== ackWait || existing.config.max_deliver !== maxDeliver)
      ) {
        await manager.consumers.update(stream, name, {
          ack_wait: ackWait,
          max_deliver: maxDeliver,
        });
      }
    } catch (error) {
      if (error instanceof JetStreamApiError) {
        throw new Error(
          `The server refused to ${existing === undefined ? 'create' : 'update'} the durable consumer ${name} of the stream ${stream} (${error.message}). The kit never deletes a consumer: an operator removes the obsolete one.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  /**
   * Method pump
   *
   * @description
   * Hands the messages of a consumer to its handler, one at a time, until the pull loop closes.
   *
   * @param {EventTarget} target - Registered handler.
   * @param {ConsumerMessages} messages - Pull loop of the consumer.
   * @returns {Promise<void>} Resolves when the loop closed and the last delivery returned.
   */
  private async pump(target: EventTarget, messages: ConsumerMessages): Promise<void> {
    try {
      for await (const message of messages) {
        await this.deliver(target, message);
      }
    } catch (error) {
      this.logger.error({ consumer: target.consumer, err: error }, 'event consumer failed');
    }
    if (!this.stopping) {
      this.logger.error({ consumer: target.consumer }, 'event consumer stopped unexpectedly');
    }
  }

  /**
   * Method logNotifications
   *
   * @description
   * Logs what the client reports about a consumer that went missing. The client keeps pulling
   * and recovers by itself once the stream and the consumer are back.
   *
   * @param {string} name - Name of the durable consumer.
   * @param {ConsumerMessages} messages - Pull loop of the consumer.
   * @returns {Promise<void>} Resolves when the pull loop closed.
   */
  private async logNotifications(name: string, messages: ConsumerMessages): Promise<void> {
    try {
      for await (const notification of messages.status()) {
        if (
          notification.type === 'consumer_not_found' ||
          notification.type === 'consumer_deleted' ||
          notification.type === 'stream_not_found'
        ) {
          this.logger.warn({ consumer: name, notification: notification.type }, 'consumer missing');
        }
      }
    } catch (error) {
      this.logger.warn({ consumer: name, err: error }, 'consumer notifications stopped');
    }
  }

  /**
   * Method deliver
   *
   * @description
   * Processes one delivery: validates the message, runs the handler inside the organization
   * context of the event and a consumer span, then acknowledges, retries or terminates.
   *
   * A message that is not valid JSON or does not match its contract can never succeed: it is
   * terminated, which makes it a dead letter at once. A handler failure asks for a redelivery
   * after the delay of that attempt; on the last attempt the redelivery is asked for at once,
   * which makes the server report the delivery limit.
   *
   * @param {EventTarget} target - Registered handler.
   * @param {JsMsg} message - Message delivered by JetStream.
   * @returns {Promise<void>} Resolves once the message was answered; it never rejects.
   */
  private async deliver(target: EventTarget, message: JsMsg): Promise<void> {
    const deliveryCount: number = message.info.deliveryCount;
    const streamSequence: number = message.info.streamSequence;
    const fields: {
      event: string;
      consumer: string;
      streamSequence: number;
      deliveryCount: number;
    } = { event: target.event, consumer: target.consumer, streamSequence, deliveryCount };
    let payload: EventEnvelope;
    try {
      const decoded: unknown = JSON.parse(message.string());
      payload = target.validate(decoded);
    } catch (error) {
      const invalid: boolean = error instanceof EventValidationError;
      message.term(invalid ? 'invalid-payload' : 'invalid-json');
      this.logger.error(
        { ...fields, issues: error instanceof EventValidationError ? error.issues : undefined },
        invalid ? 'event does not match its contract: terminated' : 'event is not JSON: terminated',
      );
      return;
    }
    const parent: Context = contextFromTraceparent(message.headers?.get(TRACEPARENT_HEADER));
    const span: Span = trace.getTracer('@cadenway/nest-messaging').startSpan(
      `process ${target.event}`,
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          'messaging.system': 'nats',
          'messaging.operation.type': 'process',
          'messaging.destination.name': message.subject,
          'messaging.consumer.group.name': target.consumer,
          'messaging.message.id': payload.id,
        },
      },
      parent,
    );
    const eventContext: Omit<EventContext, 'claimVersion'> = {
      deliveryCount,
      streamSequence,
      redelivered: message.redelivered,
    };
    try {
      const outcome: DeduplicationOutcome = await context.with(trace.setSpan(parent, span), () =>
        runWithOrganizationContext(
          {
            organizationId: payload.organizationId,
            actor: payload.actor,
            role: null,
            scopes: [],
          },
          () => this.handle(target, payload, eventContext),
        ),
      );
      message.ack();
      if (outcome === 'duplicate') {
        this.logger.debug({ ...fields, eventId: payload.id }, 'duplicate event skipped');
      }
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      const delayMs: number | undefined = retryDelayMs(deliveryCount, this.options.retryDelaysMs);
      if (delayMs === undefined) {
        message.nak();
        this.logger.error(
          { ...fields, eventId: payload.id, err: error },
          'event handler failed on the last delivery: dead letter',
        );
      } else {
        message.nak(delayMs);
        this.logger.warn(
          { ...fields, eventId: payload.id, retryInMs: delayMs, err: error },
          'event handler failed: will retry',
        );
      }
    } finally {
      span.end();
    }
  }

  /**
   * Method handle
   *
   * @description
   * Calls the handler, through the deduplicator when the application has one.
   *
   * @param {EventTarget} target - Registered handler.
   * @param {EventEnvelope} payload - Validated payload.
   * @param {Omit<EventContext, 'claimVersion'>} eventContext - Delivery details of the message.
   * @returns {Promise<DeduplicationOutcome>} `handled`, or `duplicate` when the deduplicator skipped the handler.
   */
  private async handle(
    target: EventTarget,
    payload: EventEnvelope,
    eventContext: Omit<EventContext, 'claimVersion'>,
  ): Promise<DeduplicationOutcome> {
    if (this.deduplicator === undefined) {
      await target.handle(payload, { ...eventContext, claimVersion: alwaysApply });
      return 'handled';
    }
    return this.deduplicator.run(
      { consumer: target.consumer, event: target.event, envelope: payload },
      (claimVersion: VersionClaim): Promise<void> =>
        target.handle(payload, { ...eventContext, claimVersion }),
    );
  }

  /**
   * Method serveRebuild
   *
   * @description
   * Applies the rebuild items of one entity, one at a time, and answers each emitter.
   *
   * @param {string} subject - Rebuild subject.
   * @param {Subscription} subscription - Subscription on the subject.
   * @param {RebuildSubscription<TItem>} registration - Item schema and handler.
   * @returns {Promise<void>} Resolves when the subscription closed and the last item was answered.
   */
  private async serveRebuild<TItem>(
    subject: string,
    subscription: Subscription,
    registration: RebuildSubscription<TItem>,
  ): Promise<void> {
    try {
      for await (const message of subscription as AsyncIterable<Msg>) {
        let decoded: unknown;
        try {
          decoded = JSON.parse(message.string());
        } catch {
          decoded = undefined;
        }
        const parsed: z.ZodSafeParseResult<TItem> = registration.schema.safeParse(decoded);
        if (!parsed.success) {
          message.respond(encodeRebuildReply('invalid-item'));
          this.logger.error({ subject }, 'rebuild item does not match its schema: refused');
          continue;
        }
        try {
          await registration.handle(parsed.data);
          message.respond(encodeRebuildReply(null));
        } catch (error) {
          message.respond(encodeRebuildReply('handler-failed'));
          this.logger.warn({ subject, err: error }, 'rebuild handler failed');
        }
      }
    } catch (error) {
      this.logger.error({ subject, err: error }, 'rebuild subscription failed');
    }
  }
  // #endregion
}
