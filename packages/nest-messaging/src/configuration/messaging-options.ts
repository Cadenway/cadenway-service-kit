/**
 * Constant MESSAGING_OPTIONS
 *
 * @description
 * Injection token of the options of `MessagingModule`, with every default applied.
 *
 * @type {unique symbol}
 */
export const MESSAGING_OPTIONS: unique symbol = Symbol('cadenway.messaging.options');

/**
 * Type RestrictedDeadLetterPayload
 *
 * @description
 * What the dead-letter copy of a restricted event holds: `drop` keeps the headers and empties the
 * body, which may hold a single-use code; `copy` keeps the body.
 *
 * @type {'drop' | 'copy'}
 */
export type RestrictedDeadLetterPayload = 'drop' | 'copy';

/**
 * Type RebuildAcknowledgement
 *
 * @description
 * How a rebuild emitter learns that an item arrived: `none` publishes and flushes every few
 * items, `reply` sends each item as a request and waits for the consumer to answer.
 *
 * @type {'none' | 'reply'}
 */
export type RebuildAcknowledgement = 'none' | 'reply';

/**
 * Interface DeadLetterAdvisoriesOptions
 *
 * @description
 * A separately authorized JetStream inbox for consumer advisories. Operations provisions both
 * the stream and the durable pull consumer before enabling this option.
 */
export interface DeadLetterAdvisoriesOptions {
  // #region Properties
  /**
   * Property stream
   *
   * @description
   * Stream containing the original terminal advisory subjects from the event broker.
   *
   * @type {string}
   * @readonly
   */
  readonly stream: string;

  /**
   * Property durable
   *
   * @description
   * Unfiltered durable pull consumer with explicit acknowledgements and unlimited deliveries.
   *
   * @type {string}
   * @readonly
   */
  readonly durable: string;

  /**
   * Property servers
   *
   * @description
   * Server or server list of the advisory broker.
   *
   * @type {string | readonly string[]}
   * @readonly
   */
  readonly servers: string | readonly string[];

  /**
   * Property user
   *
   * @description
   * Credential allowed to pull and acknowledge this durable only.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly user?: string;

  /**
   * Property password
   *
   * @description
   * Password of the advisory reader. Unset for anonymous test brokers.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly password?: string;
  // #endregion
}

/**
 * Interface MessagingModuleOptions
 *
 * @description
 * Options of `MessagingModule.forRoot`. Only `service` and `servers` are required; every other
 * option has the default documented on it and in the README.
 */
export interface MessagingModuleOptions {
  // #region Properties
  /**
   * Property service
   *
   * @description
   * Name of this service or gateway, such as `task-service`. It names the connection and
   * prefixes the durable consumers (`<service>__<handler>`). Letters, digits, hyphens and
   * underscores only.
   *
   * @type {string}
   * @readonly
   */
  readonly service: string;

  /**
   * Property servers
   *
   * @description
   * NATS servers to connect to, usually `NATS_URL`: one URL, several separated by commas, or a
   * list.
   *
   * @type {string | readonly string[]}
   * @readonly
   */
  readonly servers: string | readonly string[];

  /**
   * Property user
   *
   * @description
   * NATS user of this service, such as `task`. Each service connects with its own user, allowed
   * to publish its own subjects only. When set, the client receives its replies under
   * `_INBOX.<user>`, the only inbox prefix the broker lets that user subscribe to. Unset by
   * default: the connection is then anonymous, for local use.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly user?: string;

  /**
   * Property password
   *
   * @description
   * Password of the NATS user. A secret. Unset by default.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly password?: string;

  /**
   * Property connectionName
   *
   * @description
   * Name of the connection in the server monitoring. Defaults to `service`.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly connectionName?: string;

  /**
   * Property manageStreams
   *
   * @description
   * Creates or updates the events, restricted and dead-letter streams when the application
   * starts, with the limits cadenway-ops sets. Defaults to `false`: cadenway-ops owns the streams
   * and no service user may create them; the module then only checks, at start-up, that the
   * streams this service uses exist.
   *
   * @type {boolean | undefined}
   * @readonly
   */
  readonly manageStreams?: boolean;

  /**
   * Property manageConsumers
   *
   * @description
   * Lets `EventConsumers.subscribe` create the durable consumer of a handler, or update its
   * acknowledgement wait and delivery limit. Defaults to `true`. With `false` the handler binds
   * to a consumer created elsewhere and `subscribe` rejects when it is missing or filters
   * another subject. The kit never deletes nor lists a consumer.
   *
   * @type {boolean | undefined}
   * @readonly
   */
  readonly manageConsumers?: boolean;

  /**
   * Property deadLetterWorker
   *
   * @description
   * Runs the worker that copies dead letters into the dead-letter stream. Defaults to `false`:
   * notification-service alone turns it on, as the only user allowed to read the restricted
   * events.
   *
   * @type {boolean | undefined}
   * @readonly
   */
  readonly deadLetterWorker?: boolean;

  /**
   * Property deadLetterAdvisories
   *
   * @description
   * Uses a persistent advisory inbox when the dead-letter worker is enabled. Unset by default:
   * the worker keeps its existing live NATS subscriptions.
   *
   * @type {DeadLetterAdvisoriesOptions | undefined}
   * @readonly
   */
  readonly deadLetterAdvisories?: DeadLetterAdvisoriesOptions;

  /**
   * Property restrictedEvents
   *
   * @description
   * Names of the restricted events: they are published on `restricted.<name>`, stored in the
   * restricted stream, and their handlers consume from that stream. Defaults to none. Only the
   * services allowed to use the restricted stream (identity-service, which publishes them, and
   * notification-service, which consumes them) list any.
   *
   * @type {readonly string[] | undefined}
   * @readonly
   */
  readonly restrictedEvents?: readonly string[];

  /**
   * Property eventsStream
   *
   * @description
   * Name of the stream that stores the events. Defaults to `EVENTS`.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly eventsStream?: string;

  /**
   * Property restrictedStream
   *
   * @description
   * Name of the stream that stores the restricted events. Defaults to `EVENTS_RESTRICTED`.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly restrictedStream?: string;

  /**
   * Property deadLetterStream
   *
   * @description
   * Name of the stream that stores the dead letters. Defaults to `EVENTS_DLQ`.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly deadLetterStream?: string;

  /**
   * Property eventSubjectPrefix
   *
   * @description
   * First token of the subject of an event. Defaults to `evt`.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly eventSubjectPrefix?: string;

  /**
   * Property restrictedSubjectPrefix
   *
   * @description
   * First token of the subject of a restricted event. Defaults to `restricted`.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly restrictedSubjectPrefix?: string;

  /**
   * Property deadLetterSubjectPrefix
   *
   * @description
   * First token of the subject of a dead letter. Defaults to `dlq`.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly deadLetterSubjectPrefix?: string;

  /**
   * Property rebuildSubjectPrefix
   *
   * @description
   * First token of the subject of a rebuild item. Defaults to `rebuild`.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly rebuildSubjectPrefix?: string;

  /**
   * Property rebuildName
   *
   * @description
   * Name this application receives rebuilds under: it listens on `rebuild.<rebuildName>.<entity>`.
   * Defaults to `user`, else `service`: the broker lets a user subscribe to
   * `rebuild.<its user>.>` only. Letters, digits, hyphens and underscores only.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly rebuildName?: string;

  /**
   * Property rebuildAcknowledgement
   *
   * @description
   * How `RebuildEmitter.emit` sends an item. Defaults to `none`: a plain publish, with a flush
   * every `rebuildFlushEvery` items for pacing; an item the consumer cannot take in time is lost,
   * which a restartable rebuild tolerates. `reply` sends each item as a request and waits for the
   * consumer to apply it: exact back-pressure, but the consuming user needs `allow_responses`,
   * which cadenway-ops does not grant today.
   *
   * @type {RebuildAcknowledgement | undefined}
   * @readonly
   */
  readonly rebuildAcknowledgement?: RebuildAcknowledgement;

  /**
   * Property rebuildFlushEvery
   *
   * @description
   * Number of items `RebuildEmitter.emit` sends between two flushes when items are not
   * acknowledged. Defaults to 100.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly rebuildFlushEvery?: number;

  /**
   * Property eventsMaxBytes
   *
   * @description
   * Byte cap of the events stream, used when `manageStreams` is on. Defaults to 1 GiB.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly eventsMaxBytes?: number;

  /**
   * Property restrictedMaxBytes
   *
   * @description
   * Byte cap of the restricted stream, used when `manageStreams` is on. Defaults to 64 MiB.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly restrictedMaxBytes?: number;

  /**
   * Property deadLetterMaxBytes
   *
   * @description
   * Byte cap of the dead-letter stream, used when `manageStreams` is on. Defaults to 256 MiB.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly deadLetterMaxBytes?: number;

  /**
   * Property deadLetterMaxAgeDays
   *
   * @description
   * How long the dead-letter stream keeps a message, in days, used when `manageStreams` is on.
   * Defaults to 30.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly deadLetterMaxAgeDays?: number;

  /**
   * Property publishTimeoutMs
   *
   * @description
   * How long a publish waits for the JetStream acknowledgement, in milliseconds. Defaults to
   * 5000.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly publishTimeoutMs?: number;

  /**
   * Property shutdownTimeoutMs
   *
   * @description
   * How long a shutdown waits for the running handlers before it gives up on them, in
   * milliseconds. Defaults to 10000. A handler abandoned that way sees its message redelivered.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly shutdownTimeoutMs?: number;

  /**
   * Property rebuildTimeoutMs
   *
   * @description
   * How long `RebuildEmitter.emit` waits for the consumer to apply one item, in milliseconds,
   * when `rebuildAcknowledgement` is `reply`. Defaults to 30000.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly rebuildTimeoutMs?: number;

  /**
   * Property handlerTimeoutMs
   *
   * @description
   * Time an event handler may take, in milliseconds. Defaults to 25000 and must stay below the
   * 30 seconds after which the server redelivers the message. Past it the attempt is abandoned:
   * the `signal` of the handler context is aborted, the transaction of the PostgreSQL
   * deduplicator rolls back, and the message is redelivered after the next retry delay.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly handlerTimeoutMs?: number;

  /**
   * Property restrictedDeadLetterPayload
   *
   * @description
   * What the dead-letter copy of a restricted event holds. Defaults to `drop`: the headers are
   * copied and the body is emptied, because it may hold a single-use code that would otherwise
   * sit in the dead-letter stream for its whole retention. `copy` keeps the body.
   *
   * @type {RestrictedDeadLetterPayload | undefined}
   * @readonly
   */
  readonly restrictedDeadLetterPayload?: RestrictedDeadLetterPayload;

  /**
   * Exact names of regular events whose dead letters keep only broker and event diagnostics.
   * Applies when writing the dead-letter copy and defaults to an empty list.
   */
  readonly deadLetterPayloadDropEvents?: readonly string[];

  /**
   * Property rebuildMaxPending
   *
   * @description
   * Number of rebuild items that may wait at the consumer of one entity. Defaults to 1000. Past
   * it the oldest waiting items are dropped with an error log: a rebuild is restartable.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly rebuildMaxPending?: number;
  // #endregion
}

/**
 * Type ResolvedMessagingOptions
 *
 * @description
 * Options of `MessagingModule` with every default applied and the servers as a list, as the
 * providers of the package receive them under `MESSAGING_OPTIONS`.
 *
 * @type {Readonly<Required<Omit<MessagingModuleOptions, 'servers' | 'user' | 'password' | 'deadLetterAdvisories'>>> & Pick<MessagingModuleOptions, 'user' | 'password'> & { readonly servers: readonly string[]; readonly deadLetterAdvisories?: Omit<DeadLetterAdvisoriesOptions, 'servers'> & { readonly servers: readonly string[] } }}
 */
export type ResolvedMessagingOptions = Readonly<
  Required<
    Omit<
      MessagingModuleOptions,
      'servers' | 'user' | 'password' | 'deadLetterAdvisories' | 'deadLetterPayloadDropEvents'
    >
  >
> &
  Pick<MessagingModuleOptions, 'user' | 'password' | 'deadLetterPayloadDropEvents'> & {
    readonly servers: readonly string[];
    readonly deadLetterAdvisories?: Omit<DeadLetterAdvisoriesOptions, 'servers'> & {
      readonly servers: readonly string[];
    };
  };
