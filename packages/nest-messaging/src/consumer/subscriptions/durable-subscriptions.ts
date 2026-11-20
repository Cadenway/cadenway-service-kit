import { addAbortListener } from 'node:events';

import {
  AckPolicy,
  DeliverPolicy,
  JetStreamApiCodes,
  JetStreamApiError,
  type Consumer,
  type ConsumerInfo,
  type ConsumerMessages,
  type JetStreamManager,
} from '@nats-io/jetstream';
import { nanos } from '@nats-io/transport-node';
import type { Logger } from '@nestjs/common';

import { isJetStreamApiError } from '../../connection/jetstream-api-error.js';
import type { MessagingConnection } from '../../connection/messaging-connection.js';
import type { EventNameOf, EventSchemas } from '../../events/event-envelope.js';
import { validateEvent } from '../../events/event-validation.js';
import { ACK_WAIT_MS } from '../../configuration/messaging-defaults.js';
import { eventRoute, type EventRoute } from '../../transport/event-route.js';
import type { ResolvedMessagingOptions } from '../../configuration/messaging-options.js';
import type { MessagingTuning } from '../../configuration/messaging-tuning.js';
import { durableConsumerName } from '../../transport/subjects.js';
import type { EventContext } from '../delivery/event-context.js';
import type { EventDelivery } from '../delivery/event-delivery.js';
import { ConsumerRecovery } from '../recovery/consumer-recovery.js';
import type { EventSubscription } from './event-subscription.js';
import { readEventStreamProgress, type EventStreamProgress } from './event-stream-progress.js';
import type { EventTarget, PreparedEvent } from './event-target.js';
import { resolveRedelivery } from './redelivery-policy.js';
import type { RunningConsumer } from './running-consumer.js';

/**
 * Constant MAX_CATCH_UP_HANDLERS
 *
 * @description
 * Limits the broker information requests issued by one catch-up check.
 *
 * @type {number}
 */
const MAX_CATCH_UP_HANDLERS: number = 32;

/**
 * Class DurableSubscriptions
 *
 * @description
 * Registers event handlers and prepares their durable consumers before handing them to the pull loop.
 */
export class DurableSubscriptions {
  // #region Properties
  /**
   * Property consumers
   *
   * @description
   * Durable consumers being opened or pulled, by name.
   *
   * @type {Map<string, RunningConsumer>}
   * @readonly
   */
  private readonly consumers: Map<string, RunningConsumer> = new Map<string, RunningConsumer>();

  /**
   * Property recovery
   *
   * @description
   * Pull loop and recovery of the durable subscriptions.
   *
   * @type {ConsumerRecovery}
   * @readonly
   */
  private readonly recovery: ConsumerRecovery;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Shares registration and recovery policy for all durable handlers of the application.
   *
   * @param {MessagingConnection} connection - NATS connection of the application.
   * @param {ResolvedMessagingOptions} options - Routing and consumer policy.
   * @param {MessagingTuning} tuning - Retry and recovery timing.
   * @param {Logger} logger - Shared consumer logger.
   * @param {AbortSignal} shutdown - Stops registrations and recovery on application shutdown.
   * @param {EventDelivery} delivery - Processes messages pulled by the loop.
   * @constructor
   */
  public constructor(
    private readonly connection: MessagingConnection,
    private readonly options: ResolvedMessagingOptions,
    private readonly tuning: MessagingTuning,
    private readonly logger: Logger,
    private readonly shutdown: AbortSignal,
    delivery: EventDelivery,
  ) {
    this.recovery = new ConsumerRecovery(
      connection,
      logger,
      shutdown,
      tuning.consumerRecoveryDelaysMs,
      (target: EventTarget): Promise<Consumer> => this.openConsumer(target, DeliverPolicy.All),
      delivery,
    );
  }
  // #endregion

  // #region Methods
  /**
   * Method subscribe
   *
   * @description
   * Registers a handler for one event and starts delivering to it. Its redelivery schedule is
   * checked first, before any broker request. With `manageConsumers` on, the durable consumer is
   * created, or its acknowledgement wait and delivery limit updated in place; otherwise the
   * handler binds to the existing consumer.
   *
   * @param {EventSubscription<TSchemas, TName>} subscription - Handler name, event, optional redelivery schedule and handler.
   * @returns {Promise<void>} Resolves once the consumer exists and is being pulled.
   * @throws {Error} When the handler is already registered, its redelivery schedule is invalid, the stream is missing, the consumer is missing while `manageConsumers` is off or has another delivery limit than a custom schedule, the server refuses to create or update it, or it filters another subject.
   */
  public async subscribe<TSchemas extends EventSchemas, TName extends EventNameOf<TSchemas>>(
    subscription: EventSubscription<TSchemas, TName>,
  ): Promise<void> {
    this.assertAcceptingRegistrations();
    const name: string = durableConsumerName(this.options.service, subscription.handler);
    if (this.consumers.has(name)) {
      throw new Error(`The handler ${subscription.handler} is already registered.`);
    }
    const route: EventRoute = eventRoute(this.options, subscription.event);
    const target: EventTarget = {
      consumer: name,
      event: subscription.event,
      route,
      redelivery: resolveRedelivery(
        name,
        subscription.redelivery,
        this.tuning.retryDelaysMs,
        route,
      ),
      ...(subscription.transactionIsolationLevel === undefined
        ? {}
        : { transactionIsolationLevel: subscription.transactionIsolationLevel }),
      prepare: (candidate: unknown): PreparedEvent => {
        const payload = validateEvent(subscription.schemas, subscription.event, candidate);
        return {
          envelope: payload,
          handle: (eventContext: EventContext): Promise<void> =>
            subscription.handle(payload, eventContext),
        };
      },
    };
    const running: RunningConsumer = {
      target,
      messages: undefined,
      done: Promise.resolve(),
    };
    const deliverPolicy: DeliverPolicy =
      subscription.deliverPolicy === 'new' ? DeliverPolicy.New : DeliverPolicy.All;
    // Reserve the name before any broker request. A pending consumer has no pull loop to close.
    this.consumers.set(name, running);
    try {
      const consumer: Consumer = await this.openConsumer(target, deliverPolicy);
      this.assertAcceptingRegistrations();
      running.done = this.recovery.run(running, consumer);
    } catch (error) {
      this.consumers.delete(name);
      throw error;
    }
    this.logger.log(
      { consumer: name, stream: target.route.stream, subject: target.route.subject },
      'event consumer started',
    );
  }

  /**
   * Method close
   *
   * @description
   * Stops pulling each consumer and returns the completions for the shutdown deadline.
   *
   * @returns {Promise<void>[]} Completions of the running consumers.
   */
  public close(): Promise<void>[] {
    const running: Promise<void>[] = [];
    for (const consumer of this.consumers.values()) {
      running.push(consumer.done);
      void consumer.messages?.close().catch(() => undefined);
    }
    return running;
  }

  /**
   * Method areCaughtUp
   *
   * @description
   * Checks a bounded set of active durable handlers without querying unregistered consumers.
   *
   * @param {readonly string[]} handlerNames - Handler names as passed to subscribe.
   * @param {AbortSignal | undefined} signal - Cancels waiting for the result.
   * @returns {Promise<boolean>} Whether the check found every handler caught up in a continuous available interval.
   */
  public async areCaughtUp(
    handlerNames: readonly string[],
    signal?: AbortSignal,
  ): Promise<boolean> {
    const ready: boolean | undefined = await this.inspectRegistered(
      handlerNames,
      signal,
      async (manager, targets): Promise<boolean> => {
        const results: boolean[] = await Promise.all(
          [...targets.values()].map(async (target): Promise<boolean> => {
            const info: ConsumerInfo = await manager.consumers.info(
              target.route.stream,
              target.consumer,
            );
            return (
              info.config.filter_subject === target.route.subject &&
              info.num_pending === 0 &&
              info.num_ack_pending === 0
            );
          }),
        );
        return results.every(Boolean);
      },
    );
    return ready ?? false;
  }

  /**
   * Method readProgress
   *
   * @description
   * Reads guarded stream and durable metadata for the registered handlers on the events stream.
   *
   * @param {readonly string[]} handlerNames - Handler names as passed to subscribe.
   * @param {AbortSignal | undefined} signal - Cancels waiting for the result.
   * @returns {Promise<EventStreamProgress | undefined>} Metadata when the sample is usable.
   */
  public readProgress(
    handlerNames: readonly string[],
    signal?: AbortSignal,
  ): Promise<EventStreamProgress | undefined> {
    return this.inspectRegistered(handlerNames, signal, (manager, targets, cancellation) =>
      readEventStreamProgress(manager, this.options.eventsStream, targets, cancellation),
    );
  }

  /**
   * Method inspectRegistered
   *
   * @description
   * Bounds the number of registrations and stops waiting when the caller or application stops.
   *
   * @param {readonly string[]} handlerNames - Handler names to inspect.
   * @param {AbortSignal | undefined} signal - Caller cancellation.
   * @param {(manager: JetStreamManager, targets: ReadonlyMap<string, EventTarget>, signal: AbortSignal) => Promise<TResult | undefined>} read - Metadata operation scoped to the selected registrations.
   * @returns {Promise<TResult | undefined>} The observation, if delivery stayed available.
   */
  private async inspectRegistered<TResult>(
    handlerNames: readonly string[],
    signal: AbortSignal | undefined,
    read: (
      manager: JetStreamManager,
      targets: ReadonlyMap<string, EventTarget>,
      signal: AbortSignal,
    ) => Promise<TResult | undefined>,
  ): Promise<TResult | undefined> {
    const cancellation: AbortSignal =
      signal === undefined ? this.shutdown : AbortSignal.any([this.shutdown, signal]);
    const epoch: number | undefined = this.connection.currentAvailabilityEpoch();
    if (
      cancellation.aborted ||
      epoch === undefined ||
      handlerNames.length === 0 ||
      handlerNames.length > MAX_CATCH_UP_HANDLERS
    ) {
      return undefined;
    }
    const probe: Promise<TResult | undefined> = this.readRegistered(
      handlerNames,
      epoch,
      cancellation,
      read,
    ).catch(() => undefined);
    return new Promise<TResult | undefined>((resolve: (value: TResult | undefined) => void) => {
      const abortListener: Disposable = addAbortListener(cancellation, () => {
        resolve(undefined);
      });
      void probe.then((result: TResult | undefined): void => {
        abortListener[Symbol.dispose]();
        resolve(
          !cancellation.aborted && this.connection.currentAvailabilityEpoch() === epoch
            ? result
            : undefined,
        );
      });
    });
  }

  /**
   * Method readRegistered
   *
   * @description
   * Reads only locally running registrations. A replaced pull loop or interrupted availability
   * invalidates the observation.
   *
   * @param {readonly string[]} handlerNames - Handler names as passed to subscribe.
   * @param {number} epoch - Available interval in which the read began.
   * @param {AbortSignal} signal - Cancellation of the check or application shutdown.
   * @param {(manager: JetStreamManager, targets: ReadonlyMap<string, EventTarget>, signal: AbortSignal) => Promise<TResult | undefined>} read - Metadata operation scoped to the selected registrations.
   * @returns {Promise<TResult | undefined>} The observation, if the selected registrations are still running.
   */
  private async readRegistered<TResult>(
    handlerNames: readonly string[],
    epoch: number,
    signal: AbortSignal,
    read: (
      manager: JetStreamManager,
      targets: ReadonlyMap<string, EventTarget>,
      signal: AbortSignal,
    ) => Promise<TResult | undefined>,
  ): Promise<TResult | undefined> {
    const snapshots: Map<RunningConsumer, ConsumerMessages> = new Map<
      RunningConsumer,
      ConsumerMessages
    >();
    const targets: Map<string, EventTarget> = new Map<string, EventTarget>();
    for (const handler of new Set(handlerNames)) {
      const running: RunningConsumer | undefined = this.consumers.get(
        durableConsumerName(this.options.service, handler),
      );
      if (running?.messages === undefined) {
        return undefined;
      }
      snapshots.set(running, running.messages);
      targets.set(handler, running.target);
    }
    const manager: JetStreamManager = await this.connection.manager();
    signal.throwIfAborted();
    if (this.connection.currentAvailabilityEpoch() !== epoch) {
      return undefined;
    }
    const result: TResult | undefined = await read(manager, targets, signal);
    signal.throwIfAborted();
    return this.connection.currentAvailabilityEpoch() === epoch &&
      [...snapshots].every(([running, messages]) => running.messages === messages)
      ? result
      : undefined;
  }

  /**
   * Method assertAcceptingRegistrations
   *
   * @description
   * Checks the shutdown signal on either side of the broker request.
   */
  private assertAcceptingRegistrations(): void {
    if (this.shutdown.aborted) {
      throw new Error('The application is shutting down: no handler can be registered.');
    }
  }

  /**
   * Method openConsumer
   *
   * @description
   * Returns the durable consumer of a handler, after creating or updating it when the module
   * manages consumers, and checks that it filters the expected subject. A consumer the module
   * does not manage must also have the delivery limit of a custom redelivery schedule: the kit
   * cannot change it, and another limit would end the schedule early or redeliver a message the
   * handler already gave up on. It reads the consumer with `$JS.API.CONSUMER.INFO.<stream>.<name>`
   * and never lists nor deletes consumers.
   *
   * @param {EventTarget} target - Registered handler.
   * @param {DeliverPolicy} deliverPolicy - Start position when the durable needs to be created.
   * @returns {Promise<Consumer>} The consumer, ready to be pulled.
   */
  private async openConsumer(target: EventTarget, deliverPolicy: DeliverPolicy): Promise<Consumer> {
    const name: string = target.consumer;
    const stream: string = target.route.stream;
    try {
      if (this.options.manageConsumers) {
        await this.ensureConsumer(target, deliverPolicy);
      }
      const consumer: Consumer = await this.connection.jetstream.consumers.get(stream, name);
      const info: ConsumerInfo = await consumer.info(true);
      if (info.config.filter_subject !== target.route.subject) {
        throw new Error(
          `The consumer ${name} of the stream ${stream} does not filter ${target.route.subject}: a handler consumes exactly one event. Rename the handler to consume another event.`,
        );
      }
      if (
        !this.options.manageConsumers &&
        target.redelivery.custom &&
        info.config.max_deliver !== target.redelivery.maxDeliveries
      ) {
        throw new Error(
          `The consumer ${name} of the stream ${stream} allows ${String(info.config.max_deliver)} deliveries, but its handler expects ${String(target.redelivery.maxDeliveries)}: with manageConsumers off, the platform sets max_deliver.`,
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
   * delivery limit of an existing one in place, through
   * `$JS.API.CONSUMER.CREATE.<stream>.<name>.<filter>`: the consumer keeps its name, position and
   * pending messages, which are then redelivered up to the new limit. No server-side backoff is
   * set: its first entry would replace the acknowledgement wait, so the schedule of the handler
   * is applied with `nak(delay)`.
   *
   * The kit never deletes a consumer: when the server refuses the creation or the update, for
   * instance because a field that cannot change differs, it fails with an error naming the
   * consumer, and an operator removes the obsolete consumer. A creation that loses the race with
   * another replica uses the consumer that replica created.
   *
   * @param {EventTarget} target - Registered handler.
   * @param {DeliverPolicy} deliverPolicy - Start position when the durable needs to be created.
   * @returns {Promise<void>} Resolves once the consumer exists with the expected settings.
   * @throws {Error} When the server refuses to create or update the consumer.
   */
  private async ensureConsumer(target: EventTarget, deliverPolicy: DeliverPolicy): Promise<void> {
    const name: string = target.consumer;
    const stream: string = target.route.stream;
    const manager: JetStreamManager = await this.connection.manager();
    const ackWait: number = nanos(ACK_WAIT_MS);
    const maxDeliver: number = target.redelivery.maxDeliveries;
    const existing: ConsumerInfo | undefined = await this.consumerInfo(manager, stream, name);
    try {
      if (existing === undefined) {
        try {
          await manager.consumers.add(stream, {
            durable_name: name,
            name,
            filter_subject: target.route.subject,
            ack_policy: AckPolicy.Explicit,
            ack_wait: ackWait,
            max_deliver: maxDeliver,
            deliver_policy: deliverPolicy,
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
        this.logger.log(
          {
            consumer: name,
            stream,
            maxDeliver,
            previousMaxDeliver: existing.config.max_deliver,
            ackWaitMs: ACK_WAIT_MS,
            previousAckWaitMs: Math.round((existing.config.ack_wait ?? 0) / 1_000_000),
          },
          'durable consumer updated in place',
        );
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
  // #endregion
}
