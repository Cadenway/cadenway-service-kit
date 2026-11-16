import type { Consumer, ConsumerMessages } from '@nats-io/jetstream';
import type { Logger } from '@nestjs/common';

import type { MessagingConnection } from '../../connection/messaging-connection.js';
import { waitForRetry } from '../../retry/wait-for-retry.js';
import type { EventDelivery } from '../delivery/event-delivery.js';
import type { EventTarget } from '../subscriptions/event-target.js';
import type { RunningConsumer } from '../subscriptions/running-consumer.js';

/**
 * Class ConsumerRecovery
 *
 * @description
 * Owns the pull loop and reopens a missing durable consumer.
 */
export class ConsumerRecovery {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Binds the pull loop to the application shutdown signal and the configured recovery policy.
   *
   * @param {MessagingConnection} connection - NATS connection used to report readiness.
   * @param {Logger} logger - Shared consumer logger.
   * @param {AbortSignal} shutdown - Stops recovery once the application is shutting down.
   * @param {readonly number[]} delaysMs - Delays between attempts to recover, in milliseconds.
   * @param {(target: EventTarget) => Promise<Consumer>} openConsumer - Opens a durable for the given registration.
   * @param {EventDelivery} delivery - Processes each message before the loop pulls another.
   * @constructor
   */
  public constructor(
    private readonly connection: MessagingConnection,
    private readonly logger: Logger,
    private readonly shutdown: AbortSignal,
    private readonly delaysMs: readonly number[],
    private readonly openConsumer: (target: EventTarget) => Promise<Consumer>,
    private readonly delivery: EventDelivery,
  ) {}
  // #endregion

  // #region Methods
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
  public async run(running: RunningConsumer, first: Consumer): Promise<void> {
    const name: string = running.target.consumer;
    let consumer: Consumer | undefined = first;
    let quickLosses: number = 0;
    while (!this.stopped()) {
      consumer ??= await this.recover(running.target);
      if (consumer === undefined || this.stopped()) {
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
      if (this.stopped()) {
        await messages.close().catch(() => undefined);
        return;
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
   * application stops. A durable recreated by the kit starts at the beginning of the retained
   * stream because local progress cannot account for unacknowledged deliveries to other replicas.
   *
   * @param {EventTarget} target - Consumer to recover.
   * @returns {Promise<Consumer | undefined>} The consumer, or `undefined` once the application stops.
   */
  private async recover(target: EventTarget): Promise<Consumer | undefined> {
    const delays: readonly number[] = this.delaysMs;
    for (let attempt: number = 0; !this.stopped(); attempt += 1) {
      await this.pause(delays[Math.min(attempt, delays.length - 1)] ?? 0);
      if (this.stopped()) {
        return undefined;
      }
      try {
        const consumer: Consumer = await this.openConsumer(target);
        this.logger.log({ consumer: target.consumer }, 'event consumer recovered');
        return consumer;
      } catch (error) {
        this.connection.reportConsumer(target.consumer, 'missing');
        if (attempt % 10 === 0) {
          this.logger.warn(
            { consumer: target.consumer, attempt: attempt + 1, err: error },
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
   * Reads the current shutdown state, which may change across an asynchronous wait.
   *
   * @returns {boolean} Whether shutdown has started.
   */
  private stopped(): boolean {
    return this.shutdown.aborted;
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
    if (delayMs <= 0) {
      return;
    }
    await waitForRetry(delayMs, this.shutdown);
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
        await this.delivery.deliver(running.target, message);
      }
    } catch (error) {
      this.logger.error({ consumer: running.target.consumer, err: error }, 'event consumer failed');
    }
  }
  // #endregion
}
