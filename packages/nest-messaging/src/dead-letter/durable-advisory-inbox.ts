import { AckPolicy, jetstream, type Consumer, type JsMsg } from '@nats-io/jetstream';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import { Logger } from '@nestjs/common';

import type { ResolvedMessagingOptions } from '../configuration/messaging-options.js';
import { errorCategoryOf } from '../observability/error-class.js';
import { waitForRetry } from '../retry/wait-for-retry.js';

/** The outcome of the latest valid attempt to publish a dead letter. */
type CopyOutcome = 'copy-stored' | 'copy-failed' | 'invalid-advisory';

/**
 * Class DurableAdvisoryInbox
 *
 * @description
 * Pulls one advisory at a time from a separately provisioned stream. A failed copy remains
 * unacknowledged on the broker. Invalid advisory records are terminated to unblock the inbox.
 */
export class DurableAdvisoryInbox {
  // #region Properties
  /**
   * Property logger
   *
   * @description
   * Logs inbox health without connection credentials or advisory contents.
   *
   * @type {Logger}
   * @readonly
   */
  private readonly logger: Logger = new Logger('DurableAdvisoryInbox');
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Keeps the authorized connection and the durable validated at startup.
   *
   * @param {NatsConnection} connection - The advisory broker connection.
   * @param {string} stream - The operator-provisioned stream.
   * @param {string} durable - The operator-provisioned durable.
   * @param {number} timeoutMs - JetStream API timeout in milliseconds.
   * @constructor
   */
  private constructor(
    private readonly connection: NatsConnection,
    private readonly stream: string,
    private readonly durable: string,
    private readonly timeoutMs: number,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Method open
   *
   * @description
   * Connects to the advisory broker and validates the externally managed durable. Startup fails
   * if either step fails, so enabling durable mode cannot silently enable live subscriptions.
   *
   * @param {NonNullable<ResolvedMessagingOptions['deadLetterAdvisories']>} options - Advisory broker options.
   * @param {string} name - Application connection name for broker diagnostics.
   * @param {number} timeoutMs - Connection and JetStream API timeout.
   * @returns {Promise<DurableAdvisoryInbox>} The connected inbox.
   */
  public static async open(
    options: NonNullable<ResolvedMessagingOptions['deadLetterAdvisories']>,
    name: string,
    timeoutMs: number,
  ): Promise<DurableAdvisoryInbox> {
    const connection = await connect({
      servers: [...options.servers],
      name: `${name}-dead-letter-advisories`,
      user: options.user,
      pass: options.password,
      ...(options.user === undefined ? {} : { inboxPrefix: `_INBOX.${options.user}` }),
      timeout: timeoutMs,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2000,
    });
    const inbox = new DurableAdvisoryInbox(connection, options.stream, options.durable, timeoutMs);
    try {
      await inbox.openConsumer();
      return inbox;
    } catch (error) {
      await inbox.close();
      throw error;
    }
  }

  /**
   * Method close
   *
   * @description
   * Cancels outstanding pulls. The broker can redeliver any message still unacknowledged.
   *
   * @returns {Promise<void>} The connection closure.
   */
  public close(): Promise<void> {
    return this.connection.close();
  }

  /**
   * Method run
   *
   * @description
   * Reads while the service is running. Each connection interval requires a fresh consumer
   * binding. A disconnected broker, a missing consumer or a failed copy affects readiness.
   *
   * @param {AbortSignal} stop - Stops admission and retry waits.
   * @param {readonly number[]} retryDelaysMs - Broker redelivery delays after a failed copy.
   * @param {(message: JsMsg) => Promise<boolean>} copy - Returns true after the copy was stored, false for an invalid advisory.
   * @param {(problem: string | null) => void} report - Publishes the health of the advisory consumer.
   * @returns {Promise<void>} Resolves after shutdown.
   */
  public async run(
    stop: AbortSignal,
    retryDelaysMs: readonly number[],
    copy: (message: JsMsg) => Promise<boolean>,
    report: (problem: string | null) => void,
  ): Promise<void> {
    if (this.connection.isClosed()) {
      report('dead-letter advisory broker disconnected');
      return;
    }
    const transport: { interval: AbortController | undefined } = {
      interval: new AbortController(),
    };
    let copyFailed = false;
    const reportBoundConsumer = (): void => {
      report(copyFailed ? 'dead-letter copy failed' : null);
    };
    const status = this.watchConnection((connected) => {
      if (connected) {
        transport.interval ??= new AbortController();
      } else {
        transport.interval?.abort();
        transport.interval = undefined;
        if (!stop.aborted) report('dead-letter advisory broker disconnected');
      }
    });

    try {
      while (!stop.aborted && !this.connection.isClosed()) {
        const bound = transport.interval?.signal;
        if (bound === undefined) {
          await waitForRetry(2000, stop);
          continue;
        }
        const active = AbortSignal.any([stop, bound]);
        const interrupted = (): boolean => active.aborted;
        try {
          const { consumer, heartbeatMs } = await this.openConsumer();
          if (interrupted()) continue;
          reportBoundConsumer();
          while (!interrupted()) {
            const advisory = await this.pull(consumer, active);
            if (advisory === null || interrupted()) continue;
            const outcome = await this.deliver(advisory, heartbeatMs, retryDelaysMs, copy, bound);
            if (outcome === 'invalid-advisory') continue;
            copyFailed = outcome === 'copy-failed';
            if (!interrupted()) reportBoundConsumer();
          }
        } catch (error) {
          if (interrupted()) continue;
          this.logger.warn(
            { consumer: this.durable, stream: this.stream, errorClass: errorCategoryOf(error) },
            'dead-letter advisory consumer unavailable',
          );
          report('dead-letter advisory consumer unavailable');
          await waitForRetry(2000, active);
        }
      }
    } finally {
      await this.close();
      await status;
    }
  }

  /**
   * Method watchConnection
   *
   * @description
   * Watches transport availability independently of the pull and its suspended heartbeat.
   * Closing the connection ends this iterator.
   *
   * @param {(connected: boolean) => void} changed - Notifies the pull loop of an availability change.
   * @returns {Promise<void>} Resolves once status monitoring stops.
   */
  private async watchConnection(changed: (connected: boolean) => void): Promise<void> {
    try {
      for await (const status of this.connection.status()) {
        switch (status.type) {
          case 'disconnect':
          case 'reconnecting':
          case 'staleConnection':
          case 'close':
            changed(false);
            break;
          case 'reconnect':
            changed(true);
            break;
          default:
            break;
        }
      }
    } catch {
      this.logger.warn('dead-letter advisory broker monitoring stopped');
    } finally {
      changed(false);
    }
  }

  /**
   * Method pull
   *
   * @description
   * Closes an outstanding pull on disconnect or shutdown, including when the SDK has stopped
   * its heartbeat. The next connection interval starts with a new binding.
   *
   * @param {Consumer} consumer - Durable bound to the current connection interval.
   * @param {AbortSignal} active - Aborted when this connection interval ends or shutdown begins.
   * @returns {Promise<JsMsg | null>} One advisory, if received during the active interval.
   */
  private async pull(consumer: Consumer, active: AbortSignal): Promise<JsMsg | null> {
    const messages = await consumer.fetch({ max_messages: 1, expires: 1000 });
    const cancel = (): void => {
      void messages.close();
    };
    active.addEventListener('abort', cancel, { once: true });
    if (active.aborted) cancel();
    try {
      for await (const message of messages) {
        return active.aborted ? null : message;
      }
      return null;
    } finally {
      active.removeEventListener('abort', cancel);
      await messages.close();
    }
  }

  /**
   * Method openConsumer
   *
   * @description
   * Binds a durable pull consumer. Acknowledgements are required and the broker may redeliver
   * indefinitely while an original stream or the destination is temporarily unavailable.
   *
   * @returns {Promise<{ readonly consumer: Consumer; readonly heartbeatMs: number }>} The bound consumer and heartbeat interval.
   */
  private async openConsumer(): Promise<{
    readonly consumer: Consumer;
    readonly heartbeatMs: number;
  }> {
    const client = jetstream(this.connection, { timeout: this.timeoutMs });
    const consumer = await client.consumers.get(this.stream, this.durable);
    const { config } = await consumer.info(true);
    if (
      config.durable_name !== this.durable ||
      config.deliver_subject ||
      (config.filter_subject !== undefined &&
        config.filter_subject !== '' &&
        config.filter_subject !== '>') ||
      (config.filter_subjects?.length ?? 0) > 0 ||
      config.ack_policy !== AckPolicy.Explicit ||
      config.max_deliver !== -1 ||
      config.ack_wait === undefined ||
      !Number.isFinite(config.ack_wait) ||
      config.ack_wait < 3_000_000
    ) {
      throw new Error(
        'Dead-letter advisories need an unfiltered durable pull consumer with explicit acknowledgements and unlimited deliveries.',
      );
    }
    return { consumer, heartbeatMs: Math.min(10_000, Math.floor(config.ack_wait / 3_000_000)) };
  }

  /**
   * Method deliver
   *
   * @description
   * Acknowledges the advisory only after the destination stream accepted the copy. Uncertain
   * acknowledgements can be redelivered and the destination message id remains stable.
   *
   * @param {JsMsg} advisory - One advisory pulled from the inbox.
   * @param {number} heartbeatMs - Interval for acknowledgement progress while copying.
   * @param {readonly number[]} retryDelaysMs - Broker redelivery delays after failure.
   * @param {(message: JsMsg) => Promise<boolean>} copy - Writes the dead letter or classifies an invalid advisory.
   * @param {AbortSignal} bound - Stops acknowledgements when the connection interval ends.
   * @returns {Promise<CopyOutcome>} The outcome of the copy attempt.
   */
  private async deliver(
    advisory: JsMsg,
    heartbeatMs: number,
    retryDelaysMs: readonly number[],
    copy: (message: JsMsg) => Promise<boolean>,
    bound: AbortSignal,
  ): Promise<CopyOutcome> {
    const timer = setInterval(() => {
      if (!bound.aborted) advisory.working();
    }, heartbeatMs).unref();
    let copied: boolean;
    try {
      copied = await copy(advisory);
    } catch (error) {
      this.logger.warn(
        { sequence: advisory.seq, errorClass: errorCategoryOf(error) },
        'dead-letter advisory copy failed: awaiting redelivery',
      );
      const retryIndex = Math.min(advisory.info.deliveryCount - 1, retryDelaysMs.length - 1);
      if (!bound.aborted) advisory.nak(retryDelaysMs[retryIndex] ?? 5000);
      return 'copy-failed';
    } finally {
      clearInterval(timer);
    }
    if (!copied) {
      if (!bound.aborted) advisory.term('invalid-dead-letter-advisory');
      return 'invalid-advisory';
    }
    if (bound.aborted) return 'copy-stored';
    try {
      if (await advisory.ackAck({ timeout: this.timeoutMs })) return 'copy-stored';
    } catch {
      // A lost acknowledgement may be redelivered. The copy already has its broker PubAck.
    }
    this.logger.warn({ sequence: advisory.seq }, 'dead-letter advisory acknowledgement uncertain');
    return 'copy-stored';
  }
  // #endregion
}
