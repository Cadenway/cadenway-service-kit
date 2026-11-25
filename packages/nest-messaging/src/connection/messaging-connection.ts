import { addAbortListener } from 'node:events';

import { natsIndicator, type HealthIndicator, type NatsProbe } from '@cadenway/nest-common';
import {
  jetstream,
  jetstreamManager,
  type JetStreamClient,
  type JetStreamManager,
  type StreamInfo,
} from '@nats-io/jetstream';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import { Logger, type OnApplicationShutdown } from '@nestjs/common';

import type { ResolvedMessagingOptions } from '../configuration/messaging-options.js';
import { consumerAdvisorySubjects, isConsumerAdvisoryStream } from './consumer-advisory-stream.js';
import { prepareStreams } from './stream-administration.js';

/**
 * Type ConsumerAdvisoryStreamState
 *
 * @description
 * Result of observing the configured terminal advisory latch in one available interval.
 *
 * @type {'clear' | 'held' | 'unknown'}
 */
export type ConsumerAdvisoryStreamState = 'clear' | 'held' | 'unknown';

/**
 * Class MessagingConnection
 *
 * @description
 * The one NATS connection of an application, with its JetStream client. `MessagingModule` opens
 * it before any provider is used and drains it when the application shuts down.
 *
 * The connection reconnects forever: a NATS restart suspends publishing and consuming, which
 * resume by themselves. Status changes are logged, never a payload. Inject it to build a
 * readiness indicator with `messagingHealthIndicator`; the publisher, the consumers and the
 * rebuild emitter are the normal way to use NATS. The NATS clients it holds are internal: they
 * are not part of the published declarations.
 */
export class MessagingConnection implements NatsProbe, OnApplicationShutdown {
  // #region Properties
  /**
   * Property nats
   *
   * @description
   * Core NATS connection.
   *
   * @type {NatsConnection}
   * @readonly
   * @internal
   */
  public readonly nats: NatsConnection;

  /**
   * Property jetstream
   *
   * @description
   * JetStream client bound to the connection.
   *
   * @type {JetStreamClient}
   * @readonly
   * @internal
   */
  public readonly jetstream: JetStreamClient;

  /**
   * Property unhealthyConsumers
   *
   * @description
   * Durable consumers of this application that are missing or stopped, with the reason, as the
   * event consumers report them. Readiness is down while one is listed.
   *
   * @type {Map<string, string>}
   * @readonly
   */
  private readonly unhealthyConsumers: Map<string, string> = new Map<string, string>();

  /**
   * Property availabilityListeners
   *
   * @description
   * Observers of availability transitions, with one entry per watch.
   *
   * @type {Set<(available: boolean) => void>}
   * @readonly
   */
  private readonly availabilityListeners: Set<(available: boolean) => void> = new Set<
    (available: boolean) => void
  >();

  /**
   * Property connected
   *
   * @description
   * Whether the transport's latest status permits delivery.
   *
   * @type {boolean}
   */
  private connected: boolean = true;

  /**
   * Property closing
   *
   * @description
   * Once delivery shutdown starts, later transport events cannot reopen admission.
   *
   * @type {boolean}
   */
  private closing: boolean = false;

  /**
   * Property available
   *
   * @description
   * The most recent combination of transport availability and local durable health.
   *
   * @type {boolean}
   */
  private available: boolean = true;

  /**
   * Property availabilityEpoch
   *
   * @description
   * Identifies a continuous availability interval for asynchronous backlog checks.
   *
   * @type {number}
   */
  private availabilityEpoch: number = 0;

  /**
   * Property shutdownTimeoutMs
   *
   * @description
   * Time the drain of the connection may take on shutdown before it is closed, in milliseconds.
   *
   * @type {number}
   * @readonly
   */
  private readonly shutdownTimeoutMs: number;

  /**
   * Property logger
   *
   * @description
   * Logger of the connection status.
   *
   * @type {Logger}
   * @readonly
   */
  private readonly logger: Logger = new Logger('MessagingConnection');

  /**
   * Property jetstreamManager
   *
   * @description
   * JetStream management client, built on first use.
   *
   * @type {Promise<JetStreamManager> | undefined}
   */
  private jetstreamManager: Promise<JetStreamManager> | undefined;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Wraps an open connection and starts logging its status changes. Use `open`.
   *
   * @param {NatsConnection} nats - Open NATS connection.
   * @param {number} publishTimeoutMs - Time a JetStream request may take, in milliseconds.
   * @param {number} shutdownTimeoutMs - Time the drain may take on shutdown, in milliseconds.
   * @constructor
   */
  private constructor(nats: NatsConnection, publishTimeoutMs: number, shutdownTimeoutMs: number) {
    this.nats = nats;
    this.jetstream = jetstream(nats, { timeout: publishTimeoutMs });
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    void this.logStatus();
  }
  // #endregion

  // #region Methods
  /**
   * Method open
   *
   * @description
   * Connects to NATS, waiting for the first connection for as long as it takes. Then, when
   * `manageStreams` is on, creates or updates the three streams; otherwise checks that the
   * streams this application uses exist, asking only for the stream information its user is
   * given: the events stream always, the restricted stream when it lists restricted events or
   * runs the dead-letter worker, the dead-letter stream when it runs the worker.
   *
   * With a user, replies are received under `_INBOX.<user>`, the only inbox prefix the broker
   * lets that user subscribe to.
   *
   * @param {ResolvedMessagingOptions} options - Options of the module.
   * @returns {Promise<MessagingConnection>} The open connection.
   * @internal
   * @throws {Error} When the server refuses the credentials, a stream it uses is missing, or a managed stream cannot be created or updated.
   */
  public static async open(options: ResolvedMessagingOptions): Promise<MessagingConnection> {
    const nats: NatsConnection = await connect({
      servers: [...options.servers],
      name: options.connectionName,
      user: options.user,
      pass: options.password,
      ...(options.user === undefined ? {} : { inboxPrefix: `_INBOX.${options.user}` }),
      // Reconnect forever, the first connection included: a service started before NATS waits
      // for it instead of crashing.
      maxReconnectAttempts: -1,
      waitOnFirstConnect: true,
      reconnectTimeWait: 2000,
    });
    const connection: MessagingConnection = new MessagingConnection(
      nats,
      options.publishTimeoutMs,
      options.shutdownTimeoutMs,
    );
    try {
      await prepareStreams(await connection.manager(), options, connection.logger);
    } catch (error) {
      await nats.close();
      throw error;
    }
    return connection;
  }

  /**
   * Method manager
   *
   * @description
   * Returns the JetStream management client. It does not probe the account, so it needs no
   * permission on `$JS.API.INFO`.
   *
   * @returns {Promise<JetStreamManager>} The management client.
   * @internal
   */
  public manager(): Promise<JetStreamManager> {
    this.jetstreamManager ??= jetstreamManager(this.nats, {
      checkAPI: false,
      timeout: this.jetstream.getOptions().timeout,
    });
    return this.jetstreamManager;
  }

  /**
   * Method isClosed
   *
   * @description
   * Tells whether the connection was closed for good. A connection that is reconnecting is not
   * closed.
   *
   * @returns {boolean} `true` once closed.
   */
  public isClosed(): boolean {
    return this.nats.isClosed();
  }

  /**
   * Method flush
   *
   * @description
   * Makes a round trip to the server. It stays pending while the connection is down.
   *
   * @returns {Promise<void>} Resolves when the server answered.
   */
  public async flush(): Promise<void> {
    await this.nats.flush();
  }

  /**
   * Method watchAvailability
   *
   * @description
   * Calls the listener synchronously with the current transport and durable health, then whenever
   * their combined availability changes. A disconnect, stale connection, shutdown or unhealthy
   * local durable makes the state false. A successful reconnect or consumer recovery can restore
   * it once all those conditions are healthy. Inspect backlog separately through EventConsumers.
   *
   * @param {(available: boolean) => void} listener - Observer invoked synchronously. A thrown error or rejected promise is isolated.
   * @returns {() => void} Removes this watch.
   */
  public watchAvailability(listener: (available: boolean) => void): () => void {
    const observer: (available: boolean) => unknown = listener;
    const observerFailed = (): void => {
      this.logger.warn('NATS availability observer failed');
    };
    const notify = (available: boolean): void => {
      try {
        void Promise.resolve(observer(available)).catch(observerFailed);
      } catch {
        observerFailed();
      }
    };
    if (!this.closing && !this.nats.isClosed()) {
      this.availabilityListeners.add(notify);
    }
    notify(this.currentAvailabilityEpoch() !== undefined);
    return (): void => {
      this.availabilityListeners.delete(notify);
    };
  }

  /**
   * Method isConsumerAdvisoryStreamClear
   *
   * @description
   * Reads one operator-provisioned JetStream stream that retains the latest terminal advisory
   * for the configured consumers. It requests only stream metadata and never changes broker state.
   * An unavailable or misconfigured stream cannot establish that no advisory was recorded.
   *
   * @param {string} advisoryStream - The exact operational stream name from trusted configuration.
   * @param {string} eventStream - The event stream of all monitored durables.
   * @param {readonly string[]} durables - Between one and 32 distinct full JetStream durable names.
   * @param {AbortSignal | undefined} signal - Cancels waiting for the result.
   * @returns {Promise<boolean>} Whether the stream has the exact latch configuration and is empty in the current available interval.
   */
  public async isConsumerAdvisoryStreamClear(
    advisoryStream: string,
    eventStream: string,
    durables: readonly string[],
    signal?: AbortSignal,
  ): Promise<boolean> {
    return (
      (await this.consumerAdvisoryStreamState(advisoryStream, eventStream, durables, signal)) ===
      'clear'
    );
  }

  /**
   * Method consumerAdvisoryStreamState
   *
   * @description
   * Observes the exact terminal advisory latch within one available interval. A held latch
   * contains an advisory; an unknown result cannot establish its state.
   *
   * @param {string} advisoryStream - The exact operational stream name from trusted configuration.
   * @param {string} eventStream - The event stream of all monitored durables.
   * @param {readonly string[]} durables - Between one and 32 distinct full JetStream durable names.
   * @param {AbortSignal | undefined} signal - Cancels waiting for the result.
   * @returns {Promise<ConsumerAdvisoryStreamState>} The observed latch state, or unknown when it cannot be established.
   */
  public async consumerAdvisoryStreamState(
    advisoryStream: string,
    eventStream: string,
    durables: readonly string[],
    signal?: AbortSignal,
  ): Promise<ConsumerAdvisoryStreamState> {
    const epoch: number | undefined = this.currentAvailabilityEpoch();
    const subjects: ReadonlySet<string> | undefined = consumerAdvisorySubjects(
      advisoryStream,
      eventStream,
      durables,
    );
    if (signal?.aborted === true || epoch === undefined || subjects === undefined) {
      return 'unknown';
    }
    return new Promise<ConsumerAdvisoryStreamState>(
      (resolve: (value: ConsumerAdvisoryStreamState) => void) => {
        const stopWatching: () => void = this.watchAvailability((available: boolean): void => {
          if (!available) resolve('unknown');
        });
        const abortListener: Disposable | undefined =
          signal === undefined
            ? undefined
            : addAbortListener(signal, () => {
                resolve('unknown');
              });
        void this.readConsumerAdvisoryStream(advisoryStream, subjects, epoch, signal).then(
          (state: ConsumerAdvisoryStreamState): void => {
            stopWatching();
            abortListener?.[Symbol.dispose]();
            resolve(
              !signal?.aborted && this.currentAvailabilityEpoch() === epoch ? state : 'unknown',
            );
          },
        );
      },
    );
  }

  /**
   * Method readConsumerAdvisoryStream
   *
   * @description
   * Uses the management request timeout. The availability epoch fences both sides of the read.
   *
   * @param {string} streamName - Name of the stream permitted by the operator.
   * @param {ReadonlySet<string>} subjects - Expected native advisory subjects.
   * @param {number} epoch - Available interval in which the check started.
   * @param {AbortSignal | undefined} signal - Cancellation of the check.
   * @returns {Promise<ConsumerAdvisoryStreamState>} The matching latch state, or unknown on failure.
   */
  private async readConsumerAdvisoryStream(
    streamName: string,
    subjects: ReadonlySet<string>,
    epoch: number,
    signal?: AbortSignal,
  ): Promise<ConsumerAdvisoryStreamState> {
    try {
      const manager: JetStreamManager = await this.manager();
      if (signal?.aborted === true || this.currentAvailabilityEpoch() !== epoch) {
        return 'unknown';
      }
      const info: StreamInfo = await manager.streams.info(streamName);
      if (!isConsumerAdvisoryStream(info, streamName, subjects)) return 'unknown';
      if (info.state.messages === 0) return 'clear';
      return info.state.messages > 0 ? 'held' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Method currentAvailabilityEpoch
   *
   * @description
   * Identifies the available interval that a caller can check again after an asynchronous read.
   *
   * @returns {number | undefined} The current epoch when delivery is available.
   * @internal
   */
  public currentAvailabilityEpoch(): number | undefined {
    return this.available && !this.nats.isClosed() ? this.availabilityEpoch : undefined;
  }

  /**
   * Method reportConsumer
   *
   * @description
   * Records whether a durable consumer of this application works. The event consumers call it.
   *
   * @param {string} consumer - Name of the durable consumer.
   * @param {string | null} problem - What is wrong with it, or `null` once it works again.
   * @internal
   */
  public reportConsumer(consumer: string, problem: string | null): void {
    if (problem === null) {
      this.unhealthyConsumers.delete(consumer);
    } else {
      this.unhealthyConsumers.set(consumer, problem);
    }
    this.updateAvailability();
  }

  /**
   * Method consumerProblem
   *
   * @description
   * Describes the first durable consumer that does not work, for readiness.
   *
   * @returns {string | undefined} `<consumer>: <problem>`, or `undefined` when every consumer works.
   * @internal
   */
  public consumerProblem(): string | undefined {
    for (const [consumer, problem] of this.unhealthyConsumers) {
      return `${consumer}: ${problem}`;
    }
    return undefined;
  }

  /**
   * Method stopDeliveryAvailability
   *
   * @description
   * Closes admission at the beginning of shutdown without interrupting handlers in flight.
   *
   * @internal
   */
  public stopDeliveryAvailability(): void {
    this.closing = true;
    this.updateAvailability();
  }

  /**
   * Method onApplicationShutdown
   *
   * @description
   * Drains the connection: what is buffered is sent, then the connection closes. Consumers,
   * the dead-letter worker and the outbox relay have stopped before, in the earlier shutdown
   * phase. A drain that does not finish within `shutdownTimeoutMs`, as when the server is gone,
   * gives way to a plain close.
   *
   * @returns {Promise<void>} Resolves once the connection is closed.
   */
  public async onApplicationShutdown(): Promise<void> {
    this.stopDeliveryAvailability();
    if (this.nats.isClosed()) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut: Promise<'timeout'> = new Promise<'timeout'>(
      (resolve: (value: 'timeout') => void) => {
        timer = setTimeout(() => {
          resolve('timeout');
        }, this.shutdownTimeoutMs);
      },
    );
    try {
      const outcome: 'drained' | 'timeout' = await Promise.race([
        this.nats.drain().then((): 'drained' => 'drained'),
        timedOut,
      ]);
      if (outcome === 'timeout') {
        this.logger.warn(
          { timeoutMs: this.shutdownTimeoutMs },
          'draining the NATS connection timed out: closing it',
        );
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'draining the NATS connection failed');
    } finally {
      clearTimeout(timer);
    }
    if (!this.nats.isClosed()) {
      await this.nats.close();
    }
  }

  /**
   * Method logStatus
   *
   * @description
   * Logs the status changes of the connection until it closes. Reconnection attempts are logged
   * at debug level: there is one every two seconds while the server is away.
   *
   * @returns {Promise<void>} Resolves when the connection is closed.
   */
  private async logStatus(): Promise<void> {
    try {
      for await (const status of this.nats.status()) {
        switch (status.type) {
          case 'disconnect':
            this.connected = false;
            this.updateAvailability();
            this.logger.warn({ server: status.server }, 'NATS connection lost');
            break;
          case 'reconnect':
            this.connected = true;
            this.updateAvailability();
            this.logger.log({ server: status.server }, 'NATS connection restored');
            break;
          case 'reconnecting':
            this.connected = false;
            this.updateAvailability();
            this.logger.debug('reconnecting to NATS');
            break;
          case 'staleConnection':
            this.connected = false;
            this.updateAvailability();
            this.logger.warn('NATS connection is stale');
            break;
          case 'slowConsumer':
            this.logger.warn({ pending: status.pending }, 'NATS subscription is a slow consumer');
            break;
          case 'error':
            this.logger.error({ err: status.error }, 'NATS connection error');
            break;
          default:
            break;
        }
      }
    } catch {
      this.logger.warn('NATS status monitoring stopped');
    } finally {
      this.connected = false;
      this.updateAvailability();
      this.availabilityListeners.clear();
    }
  }

  /**
   * Method updateAvailability
   *
   * @description
   * Invalidates outstanding snapshots and synchronously notifies observers when delivery changes.
   */
  private updateAvailability(): void {
    const available: boolean =
      this.connected &&
      !this.closing &&
      !this.nats.isClosed() &&
      this.unhealthyConsumers.size === 0;
    if (available === this.available) {
      return;
    }
    this.available = available;
    this.availabilityEpoch += 1;
    const epoch: number = this.availabilityEpoch;
    for (const listener of [...this.availabilityListeners]) {
      if (this.availabilityEpoch !== epoch) {
        return;
      }
      if (this.availabilityListeners.has(listener)) {
        listener(available);
      }
    }
  }
  // #endregion
}

/**
 * Function messagingHealthIndicator
 *
 * @description
 * Builds the readiness indicator of NATS for `HealthModule` of `@cadenway/nest-common`: the
 * connection is not closed, every durable consumer of the application works (none missing,
 * being recovered or stopped), and a flush makes the round trip. While the connection is
 * reconnecting the flush does not answer, so readiness reports NATS down after its timeout.
 *
 * @param {MessagingConnection} connection - Connection of the application, injected.
 * @param {string} name - Key of the dependency in the readiness body; defaults to `nats`.
 * @returns {HealthIndicator} The indicator.
 */
export function messagingHealthIndicator(
  connection: MessagingConnection,
  name: string = 'nats',
): HealthIndicator {
  const nats: HealthIndicator = natsIndicator(connection, name);
  return {
    name,
    check: async (): Promise<void> => {
      const problem: string | undefined = connection.consumerProblem();
      if (problem !== undefined) {
        throw new Error(`A durable consumer does not work (${problem}).`);
      }
      await nats.check();
    },
  };
}
