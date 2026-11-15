import {
  runWithOrganizationContext,
  type InternalActor,
  type OrganizationContext,
} from '@cadenway/nest-common';
import {
  AckPolicy,
  DeliverPolicy,
  JetStreamApiCodes,
  JetStreamApiError,
  type Consumer,
  type ConsumerConfig,
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
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
} from '@opentelemetry/api';
import type { z } from 'zod';

import { isJetStreamApiError, MessagingConnection } from '../connection/messaging-connection.js';
import { errorClassOf } from '../error-class.js';
import {
  EVENT_ACTOR_TYPES,
  type EventActor,
  type EventActorType,
  type EventEnvelope,
  type EventNameOf,
  type EventPayloadOf,
  type EventSchemas,
} from '../events/event-envelope.js';
import { EventValidationError, validateEvent } from '../events/event-validation.js';
import {
  ACK_WAIT_MS,
  eventRoute,
  MESSAGING_OPTIONS,
  type EventRoute,
  type ResolvedMessagingOptions,
} from '../messaging-options.js';
import { MESSAGING_TUNING, type MessagingTuning } from '../messaging-tuning.js';
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
   * Name of the entity, such as `task`: the last token of `rebuild.<rebuild name>.<entity>`.
   *
   * @type {string}
   * @readonly
   */
  readonly entity: string;

  /**
   * Property schema
   *
   * @description
   * Zod schema of an item. An item that does not match is refused.
   *
   * @type {z.ZodType<TItem>}
   * @readonly
   */
  readonly schema: z.ZodType<TItem>;

  /**
   * Property handle
   *
   * @description
   * Applies one item. It runs in a context without organization, whatever the context
   * `onRebuild` was called in: it opens the transaction it needs itself. It must be idempotent,
   * since a rebuild may be started again.
   *
   * @type {(item: TItem) => Promise<void>}
   * @readonly
   */
  readonly handle: (item: TItem) => Promise<void>;
  // #endregion
}

/**
 * Class HandlerTimeoutError
 *
 * @description
 * Reason of the `signal` of a handler aborted at `handlerTimeoutMs`, and error of the abandoned
 * attempt.
 */
export class HandlerTimeoutError extends Error {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Builds the error.
   *
   * @param {number} timeoutMs - Deadline that was reached, in milliseconds.
   * @constructor
   */
  public constructor(timeoutMs: number) {
    super(`The event handler did not finish within ${String(timeoutMs)} ms.`);
    this.name = 'HandlerTimeoutError';
  }
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

/**
 * Interface RunningConsumer
 *
 * @description
 * A durable consumer being pulled, with what its recovery needs.
 */
interface RunningConsumer {
  // #region Properties
  /**
   * Property target
   *
   * @description
   * Registered handler.
   *
   * @type {EventTarget}
   * @readonly
   */
  readonly target: EventTarget;

  /**
   * Property startedAt
   *
   * @description
   * Instant the handler was registered, in milliseconds.
   *
   * @type {number}
   * @readonly
   */
  readonly startedAt: number;

  /**
   * Property lastHandledAt
   *
   * @description
   * Stream time of the last message this process answered for good, in milliseconds.
   *
   * @type {number | undefined}
   */
  lastHandledAt: number | undefined;

  /**
   * Property retrying
   *
   * @description
   * Stream time of the messages waiting for a redelivery, by stream sequence, in milliseconds.
   *
   * @type {Map<number, number>}
   * @readonly
   */
  readonly retrying: Map<number, number>;

  /**
   * Property messages
   *
   * @description
   * Current pull loop of the client; closing it stops pulling.
   *
   * @type {ConsumerMessages | undefined}
   */
  messages: ConsumerMessages | undefined;

  /**
   * Property done
   *
   * @description
   * Resolves when the handler stopped for good.
   *
   * @type {Promise<void>}
   */
  done: Promise<void>;
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
 * Constant RECOVERY_MARGIN_MS
 *
 * @description
 * How far before the last message this process handled a consumer created again with
 * `deliverPolicy: 'new'` starts, in milliseconds: the events published around the loss are
 * delivered again rather than skipped.
 *
 * @type {number}
 */
const RECOVERY_MARGIN_MS: number = 60_000;

/**
 * Constant NO_ORGANIZATION
 *
 * @description
 * Organization context of the work that belongs to no organization: rebuild handlers.
 *
 * @type {OrganizationContext}
 */
const NO_ORGANIZATION: OrganizationContext = {
  organizationId: null,
  actor: { type: 'system', id: null },
  role: null,
  scopes: [],
};

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
 * Function untilAborted
 *
 * @description
 * Settles like a promise, or rejects with the reason of a signal as soon as it is aborted. The
 * work itself is not stopped: it is abandoned.
 *
 * @param {Promise<TResult>} work - Work to wait for.
 * @param {AbortSignal} signal - Signal of the deadline.
 * @returns {Promise<TResult>} What the work returns, unless the signal is aborted first.
 */
function untilAborted<TResult>(work: Promise<TResult>, signal: AbortSignal): Promise<TResult> {
  const reasonOf: () => Error = (): Error =>
    signal.reason instanceof Error ? signal.reason : new Error('The work was aborted.');
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(reasonOf());
  }
  return new Promise<TResult>(
    (resolve: (value: TResult) => void, reject: (reason: Error) => void) => {
      const onAbort: () => void = (): void => {
        reject(reasonOf());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        (value: TResult) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    },
  );
}

/**
 * Function streamTimeOf
 *
 * @description
 * Reads the instant a message was stored in its stream.
 *
 * @param {JsMsg} message - Message delivered by JetStream.
 * @returns {number} The instant, in milliseconds.
 */
function streamTimeOf(message: JsMsg): number {
  return Math.floor(message.info.timestampNanos / 1_000_000);
}

/**
 * Function answerSafely
 *
 * @description
 * Sends the answer to a message (`ack`, `nak` or `term`). The connection may have closed while
 * the handler ran: the answer is then lost, the server redelivers the message, and the failure is
 * reported to `onError` instead of thrown.
 *
 * @param {() => void} answer - Sends the answer.
 * @param {(error: unknown) => void} onError - Called when the answer could not be sent.
 * @returns {void}
 */
export function answerSafely(answer: () => void, onError: (error: unknown) => void): void {
  try {
    answer();
  } catch (error) {
    onError(error);
  }
}

/**
 * Function contextActorOf
 *
 * @description
 * Narrows the actor of an envelope to the actor of an organization context. A kind of actor this
 * version of the kit does not know becomes the system, without identity.
 *
 * @param {EventActor} actor - Actor of the validated envelope.
 * @returns {InternalActor | undefined} The actor of the context, or `undefined` when its kind is unknown.
 */
export function contextActorOf(actor: EventActor): InternalActor | undefined {
  return (EVENT_ACTOR_TYPES as readonly string[]).includes(actor.type)
    ? { type: actor.type as EventActorType, id: actor.id }
    : undefined;
}

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
   * Property unknownActors
   *
   * @description
   * Consumer and actor kind pairs already warned about, so the warning is logged once.
   *
   * @type {Set<string>}
   * @readonly
   */
  private readonly unknownActors: Set<string> = new Set<string>();

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
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Stores the connection, the options, the timings and the deduplicator when the application
   * provides one.
   *
   * @param {MessagingConnection} connection - NATS connection of the application.
   * @param {ResolvedMessagingOptions} options - Options of the module.
   * @param {MessagingTuning} tuning - Retry and recovery timings.
   * @param {EventDeduplicator | undefined} deduplicator - Deduplicator of the application, when it has one.
   * @constructor
   */
  public constructor(
    private readonly connection: MessagingConnection,
    @Inject(MESSAGING_OPTIONS) private readonly options: ResolvedMessagingOptions,
    @Inject(MESSAGING_TUNING) private readonly tuning: MessagingTuning,
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
   * @throws {Error} When the handler is already registered, the stream is missing, the consumer is missing while `manageConsumers` is off, the server refuses to create or update it, or it filters another subject.
   */
  public async subscribe<TSchemas extends EventSchemas, TName extends EventNameOf<TSchemas>>(
    subscription: EventSubscription<TSchemas, TName>,
  ): Promise<void> {
    if (this.stopped()) {
      throw new Error('The application is shutting down: no handler can be registered.');
    }
    const name: string = durableConsumerName(this.options.service, subscription.handler);
    if (this.consumers.has(name)) {
      throw new Error(`The handler ${subscription.handler} is already registered.`);
    }
    const target: EventTarget = {
      consumer: name,
      event: subscription.event,
      route: eventRoute(this.options, subscription.event),
      deliverPolicy: subscription.deliverPolicy ?? 'all',
      validate: (candidate: unknown): EventEnvelope =>
        validateEvent(subscription.schemas, subscription.event, candidate),
      handle: (payload: EventEnvelope, eventContext: EventContext): Promise<void> =>
        subscription.handle(payload as EventPayloadOf<TSchemas, TName>, eventContext),
    };
    const running: RunningConsumer = {
      target,
      startedAt: Date.now(),
      lastHandledAt: undefined,
      retrying: new Map<number, number>(),
      messages: undefined,
      done: Promise.resolve(),
    };
    const consumer: Consumer = await this.openConsumer(target, undefined);
    this.consumers.set(name, running);
    running.done = this.run(running, consumer);
    this.logger.log(
      { consumer: name, stream: target.route.stream, subject: target.route.subject },
      'event consumer started',
    );
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
    if (this.stopped()) {
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
    // The loop starts in an explicit context: it must not inherit the organization, or the
    // trace, of whoever registered the handler.
    const done: Promise<void> = context.with(ROOT_CONTEXT, () =>
      runWithOrganizationContext(NO_ORGANIZATION, () =>
        this.serveRebuild(subject, subscription, registration),
      ),
    );
    this.rebuilds.set(subject, { subscription, done });
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
    this.stop.abort();
    const running: Promise<void>[] = [];
    for (const consumer of this.consumers.values()) {
      running.push(consumer.done);
      void consumer.messages?.close().catch(() => undefined);
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
   * Method run
   *
   * @description
   * Pulls a consumer until the application stops. When the consumer disappears, or the pull loop
   * ends on its own, the consumer is reported to readiness and recovered, then pulled again.
   *
   * @param {RunningConsumer} running - Consumer being run.
   * @param {Consumer} first - Consumer opened by `subscribe`.
   * @returns {Promise<void>} Resolves when the application stops.
   */
  private async run(running: RunningConsumer, first: Consumer): Promise<void> {
    const name: string = running.target.consumer;
    let consumer: Consumer | undefined = first;
    let quickLosses: number = 0;
    while (!this.stopped()) {
      consumer ??= await this.recover(running);
      if (consumer === undefined) {
        return;
      }
      const pulledAt: number = Date.now();
      let messages: ConsumerMessages;
      try {
        // One message at a time: nothing waits in a client buffer while its acknowledgement
        // clock runs on the server.
        messages = await consumer.consume({ max_messages: 1 });
      } catch (error) {
        this.logger.warn({ consumer: name, err: error }, 'event consumer could not start pulling');
        this.connection.reportConsumer(name, 'stopped');
        consumer = undefined;
        continue;
      }
      running.messages = messages;
      this.connection.reportConsumer(name, null);
      void this.watch(name, messages);
      await this.pump(running, messages);
      consumer = undefined;
      if (!this.stopped()) {
        this.connection.reportConsumer(name, 'missing');
        this.logger.warn({ consumer: name }, 'event consumer lost: recovering it');
        // A pull loop that keeps ending at once must not spin.
        quickLosses = Date.now() - pulledAt < 5000 ? quickLosses + 1 : 0;
        await this.pause(Math.min(1000 * quickLosses, 30_000));
      }
    }
  }

  /**
   * Method watch
   *
   * @description
   * Closes a pull loop when the client reports that its consumer or its stream is gone. The
   * client would otherwise poll the consumer forever without creating it again. A pull that
   * finds no responder means the same: a consumer deleted between two pulls is reported that
   * way rather than as deleted, and the client then pulls again in a tight loop.
   *
   * @param {string} name - Name of the durable consumer.
   * @param {ConsumerMessages} messages - Pull loop of the consumer.
   * @returns {Promise<void>} Resolves when the pull loop closed.
   */
  private async watch(name: string, messages: ConsumerMessages): Promise<void> {
    try {
      for await (const notification of messages.status()) {
        if (
          notification.type === 'consumer_not_found' ||
          notification.type === 'consumer_deleted' ||
          notification.type === 'stream_not_found' ||
          notification.type === 'no_responders'
        ) {
          this.connection.reportConsumer(name, 'missing');
          this.logger.warn({ consumer: name, notification: notification.type }, 'consumer missing');
          await messages.close();
          return;
        }
      }
    } catch (error) {
      this.logger.debug({ consumer: name, err: error }, 'consumer notifications stopped');
    }
  }

  /**
   * Method recover
   *
   * @description
   * Opens a consumer that disappeared again, retrying with a growing pause until it works or the
   * application stops. With `manageConsumers` it is created again: with `deliverPolicy: 'all'`
   * from the start of the stream, with `new` from the stream time of the oldest message this
   * process has not answered for good (the last one it handled, or the registration when it
   * handled none, and any message waiting for a redelivery), minus a minute.
   *
   * @param {RunningConsumer} running - Consumer to recover.
   * @returns {Promise<Consumer | undefined>} The consumer, or `undefined` once the application stops.
   */
  private async recover(running: RunningConsumer): Promise<Consumer | undefined> {
    const delays: readonly number[] = this.tuning.consumerRecoveryDelaysMs;
    for (let attempt: number = 0; !this.stopped(); attempt += 1) {
      await this.pause(delays[Math.min(attempt, delays.length - 1)] ?? 0);
      if (this.stopped()) {
        return undefined;
      }
      const startFrom: number =
        Math.min(running.lastHandledAt ?? running.startedAt, ...running.retrying.values()) -
        RECOVERY_MARGIN_MS;
      try {
        const consumer: Consumer = await this.openConsumer(
          running.target,
          running.target.deliverPolicy === 'new' ? new Date(startFrom) : undefined,
        );
        this.logger.log({ consumer: running.target.consumer }, 'event consumer recovered');
        return consumer;
      } catch (error) {
        this.connection.reportConsumer(running.target.consumer, 'missing');
        if (attempt % 10 === 0) {
          this.logger.warn(
            { consumer: running.target.consumer, attempt: attempt + 1, err: error },
            'event consumer could not be recovered yet',
          );
        }
      }
    }
    return undefined;
  }

  /**
   * Method stopped
   *
   * @description
   * Tells whether the application is shutting down.
   *
   * @returns {boolean} `true` once the shutdown started.
   */
  private stopped(): boolean {
    return this.stop.signal.aborted;
  }

  /**
   * Method pause
   *
   * @description
   * Waits, unless the application stops first.
   *
   * @param {number} delayMs - Pause, in milliseconds.
   * @returns {Promise<void>} Resolves after the pause or on shutdown.
   */
  private async pause(delayMs: number): Promise<void> {
    if (delayMs <= 0 || this.stopped()) {
      return;
    }
    await new Promise<void>((resolve: () => void) => {
      const timer: NodeJS.Timeout = setTimeout(done, delayMs);
      this.stop.signal.addEventListener('abort', done, { once: true });
      /**
       * Function done
       *
       * @description
       * Ends the pause.
       *
       * @returns {void}
       */
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  /**
   * Method openConsumer
   *
   * @description
   * Returns the durable consumer of a handler, after creating or updating it when the module
   * manages consumers, and checks that it filters the expected subject. It reads the consumer
   * with `$JS.API.CONSUMER.INFO.<stream>.<name>` and never lists nor deletes consumers.
   *
   * @param {EventTarget} target - Registered handler.
   * @param {Date | undefined} startFrom - Start time of a consumer created again, for `deliverPolicy: 'new'`.
   * @returns {Promise<Consumer>} The consumer, ready to be pulled.
   */
  private async openConsumer(target: EventTarget, startFrom: Date | undefined): Promise<Consumer> {
    const name: string = target.consumer;
    const stream: string = target.route.stream;
    try {
      if (this.options.manageConsumers) {
        await this.ensureConsumer(target, startFrom);
      }
      const consumer: Consumer = await this.connection.jetstream.consumers.get(stream, name);
      const info: ConsumerInfo = await consumer.info(true);
      if (info.config.filter_subject !== target.route.subject) {
        throw new Error(
          `The consumer ${name} of the stream ${stream} does not filter ${target.route.subject}: a handler consumes exactly one event. Rename the handler to consume another event.`,
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
   * consumer, and an operator removes the obsolete consumer. A creation that loses the race with
   * another replica uses the consumer that replica created.
   *
   * @param {EventTarget} target - Registered handler.
   * @param {Date | undefined} startFrom - Start time of a consumer created again, for `deliverPolicy: 'new'`.
   * @returns {Promise<void>} Resolves once the consumer exists with the expected settings.
   * @throws {Error} When the server refuses to create or update the consumer.
   */
  private async ensureConsumer(target: EventTarget, startFrom: Date | undefined): Promise<void> {
    const name: string = target.consumer;
    const stream: string = target.route.stream;
    const manager: JetStreamManager = await this.connection.manager();
    const ackWait: number = nanos(ACK_WAIT_MS);
    const maxDeliver: number = maxDeliveriesOf(this.tuning.retryDelaysMs);
    const existing: ConsumerInfo | undefined = await this.consumerInfo(manager, stream, name);
    try {
      if (existing === undefined) {
        const start: Partial<ConsumerConfig> =
          startFrom === undefined
            ? {
                deliver_policy:
                  target.deliverPolicy === 'new' ? DeliverPolicy.New : DeliverPolicy.All,
              }
            : { deliver_policy: DeliverPolicy.StartTime, opt_start_time: startFrom.toISOString() };
        try {
          await manager.consumers.add(stream, {
            durable_name: name,
            name,
            filter_subject: target.route.subject,
            ack_policy: AckPolicy.Explicit,
            ack_wait: ackWait,
            max_deliver: maxDeliver,
            ...start,
          });
        } catch (error) {
          if ((await this.consumerInfo(manager, stream, name)) === undefined) {
            throw error;
          }
        }
        return;
      }
      if (
        existing.config.filter_subject === target.route.subject &&
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
   * Method consumerInfo
   *
   * @description
   * Reads a consumer, telling a missing one from an error.
   *
   * @param {JetStreamManager} manager - JetStream management client.
   * @param {string} stream - Name of the stream.
   * @param {string} name - Name of the durable consumer.
   * @returns {Promise<ConsumerInfo | undefined>} The consumer, or `undefined` when it does not exist.
   */
  private async consumerInfo(
    manager: JetStreamManager,
    stream: string,
    name: string,
  ): Promise<ConsumerInfo | undefined> {
    try {
      return await manager.consumers.info(stream, name);
    } catch (error) {
      if (isJetStreamApiError(error, JetStreamApiCodes.ConsumerNotFound)) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Method pump
   *
   * @description
   * Hands the messages of a pull loop to the handler, one at a time, until the loop closes.
   *
   * @param {RunningConsumer} running - Consumer being run.
   * @param {ConsumerMessages} messages - Pull loop of the consumer.
   * @returns {Promise<void>} Resolves when the loop closed and the last delivery returned.
   */
  private async pump(running: RunningConsumer, messages: ConsumerMessages): Promise<void> {
    try {
      for await (const message of messages) {
        await this.deliver(running, message);
      }
    } catch (error) {
      this.logger.error({ consumer: running.target.consumer, err: error }, 'event consumer failed');
    }
  }

  /**
   * Method answer
   *
   * @description
   * Sends the answer to a message and records what recovery needs: a message waiting for a
   * redelivery, or the stream time of the last one answered for good.
   *
   * @param {RunningConsumer} running - Consumer being run.
   * @param {JsMsg} message - Message delivered by JetStream.
   * @param {'ack' | 'term' | 'nak'} answer - Answer to send.
   * @param {string | number | undefined} detail - Reason of a `term`; delay of a `nak`, in milliseconds, none asking for an immediate redelivery.
   * @returns {void}
   */
  private answer(
    running: RunningConsumer,
    message: JsMsg,
    answer: 'ack' | 'term' | 'nak',
    detail?: string | number,
  ): void {
    const sequence: number = message.info.streamSequence;
    if (answer === 'nak' && typeof detail === 'number') {
      running.retrying.set(sequence, streamTimeOf(message));
    } else {
      running.retrying.delete(sequence);
      running.lastHandledAt = Math.max(running.lastHandledAt ?? 0, streamTimeOf(message));
    }
    answerSafely(
      () => {
        if (answer === 'ack') {
          message.ack();
        } else if (answer === 'term') {
          message.term(typeof detail === 'string' ? detail : undefined);
        } else {
          message.nak(typeof detail === 'number' ? detail : undefined);
        }
      },
      (error: unknown) => {
        this.logger.debug(
          { consumer: running.target.consumer, streamSequence: sequence, err: error },
          'the answer to a message could not be sent: it will be redelivered',
        );
      },
    );
  }

  /**
   * Method deliver
   *
   * @description
   * Processes one delivery: validates the message, runs the handler inside the organization
   * context of the event and a consumer span, within `handlerTimeoutMs`, then acknowledges,
   * retries or terminates.
   *
   * A message that is not valid JSON or does not match its contract can never succeed: it is
   * terminated, which makes it a dead letter at once. A handler failure or timeout asks for a
   * redelivery after the delay of that attempt; on the last attempt the redelivery is asked for
   * at once, which makes the server report the delivery limit. The span records the class of
   * the error only, never its message.
   *
   * @param {RunningConsumer} running - Consumer being run.
   * @param {JsMsg} message - Message delivered by JetStream.
   * @returns {Promise<void>} Resolves once the message was answered; it never rejects.
   */
  private async deliver(running: RunningConsumer, message: JsMsg): Promise<void> {
    const target: EventTarget = running.target;
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
      this.answer(running, message, 'term', invalid ? 'invalid-payload' : 'invalid-json');
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
    const deadline: AbortController = new AbortController();
    const timer: NodeJS.Timeout = setTimeout(() => {
      deadline.abort(new HandlerTimeoutError(this.options.handlerTimeoutMs));
    }, this.options.handlerTimeoutMs);
    const eventContext: Omit<EventContext, 'claimVersion'> = {
      deliveryCount,
      streamSequence,
      redelivered: message.redelivered,
      signal: deadline.signal,
    };
    try {
      const outcome: DeduplicationOutcome = await context.with(trace.setSpan(parent, span), () =>
        runWithOrganizationContext(this.organizationContextOf(target, payload), () =>
          untilAborted(this.handle(target, payload, eventContext), deadline.signal),
        ),
      );
      this.answer(running, message, 'ack');
      if (outcome === 'duplicate') {
        this.logger.debug({ ...fields, eventId: payload.id }, 'duplicate event skipped');
      }
    } catch (error) {
      const errorClass: string = errorClassOf(error);
      span.setAttribute('error.type', errorClass);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorClass });
      const timedOut: boolean = error instanceof HandlerTimeoutError;
      const delayMs: number | undefined = retryDelayMs(deliveryCount, this.tuning.retryDelaysMs);
      if (delayMs === undefined) {
        this.answer(running, message, 'nak');
        this.logger.error(
          { ...fields, eventId: payload.id, err: error },
          'event handler failed on the last delivery: dead letter',
        );
      } else {
        this.answer(running, message, 'nak', delayMs);
        this.logger.warn(
          { ...fields, eventId: payload.id, retryInMs: delayMs, err: error },
          timedOut ? 'event handler timed out: will retry' : 'event handler failed: will retry',
        );
      }
    } finally {
      clearTimeout(timer);
      span.end();
    }
  }

  /**
   * Method organizationContextOf
   *
   * @description
   * Builds the organization context of a delivery from its validated envelope. An actor kind
   * this version of the kit does not know opens the context as the system, without identity,
   * and is logged once per consumer and kind: upgrade the kit when the contracts add one.
   *
   * @param {EventTarget} target - Registered handler.
   * @param {EventEnvelope} payload - Validated payload.
   * @returns {OrganizationContext} The organization context.
   */
  private organizationContextOf(target: EventTarget, payload: EventEnvelope): OrganizationContext {
    let actor: InternalActor | undefined = contextActorOf(payload.actor);
    if (actor === undefined) {
      const key: string = `${target.consumer}|${payload.actor.type}`;
      if (!this.unknownActors.has(key)) {
        this.unknownActors.add(key);
        this.logger.warn(
          { consumer: target.consumer, actorType: payload.actor.type.slice(0, 64) },
          'unknown actor type: handled as the system; upgrade @cadenway/nest-messaging',
        );
      }
      actor = { type: 'system', id: null };
    }
    return { organizationId: payload.organizationId, actor, role: null, scopes: [] };
  }

  /**
   * Method handle
   *
   * @description
   * Calls the handler, through the deduplicator when the application has one. The handler is
   * abandoned at the deadline even inside the deduplicator, whose transaction then rolls back.
   *
   * @param {EventTarget} target - Registered handler.
   * @param {EventEnvelope} payload - Validated payload.
   * @param {Omit<EventContext, 'claimVersion'>} eventContext - Delivery details and deadline signal.
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
        untilAborted(
          target.handle(payload, { ...eventContext, claimVersion }),
          eventContext.signal,
        ),
    );
  }

  /**
   * Method serveRebuild
   *
   * @description
   * Applies the rebuild items of one entity, one at a time, answers each request, and drops the
   * oldest waiting items while more than `rebuildMaxPending` wait.
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
    let dropped: number = 0;
    try {
      for await (const message of subscription as AsyncIterable<Msg>) {
        if (subscription.getPending() > this.options.rebuildMaxPending) {
          dropped += 1;
          message.respond(encodeRebuildReply('overloaded'));
          if (dropped === 1 || dropped % 1000 === 0) {
            this.logger.error(
              { subject, dropped, maxPending: this.options.rebuildMaxPending },
              'rebuild items arrive faster than they are applied: dropped',
            );
          }
          continue;
        }
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
