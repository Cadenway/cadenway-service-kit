import type { ConfigShape } from '@cadenway/nest-common';
import { z } from 'zod';

import { eventSubject } from './subjects.js';

/**
 * Constant MESSAGING_OPTIONS
 *
 * @description
 * Injection token of the options of `MessagingModule`, with every default applied.
 *
 * @type {symbol}
 */
export const MESSAGING_OPTIONS: unique symbol = Symbol('cadenway.messaging.options');

/**
 * Constant DEFAULT_EVENTS_STREAM
 *
 * @description
 * Name of the stream that stores the events.
 *
 * @type {string}
 */
export const DEFAULT_EVENTS_STREAM: string = 'EVENTS';

/**
 * Constant DEFAULT_RESTRICTED_STREAM
 *
 * @description
 * Name of the stream that stores the restricted events: the identity events that carry a
 * single-use code or link, which only notification-service may read.
 *
 * @type {string}
 */
export const DEFAULT_RESTRICTED_STREAM: string = 'EVENTS_RESTRICTED';

/**
 * Constant DEFAULT_DEAD_LETTER_STREAM
 *
 * @description
 * Name of the stream that stores the dead letters.
 *
 * @type {string}
 */
export const DEFAULT_DEAD_LETTER_STREAM: string = 'EVENTS_DLQ';

/**
 * Constant DEFAULT_EVENT_SUBJECT_PREFIX
 *
 * @description
 * First token of the subject of an event.
 *
 * @type {string}
 */
export const DEFAULT_EVENT_SUBJECT_PREFIX: string = 'evt';

/**
 * Constant DEFAULT_RESTRICTED_SUBJECT_PREFIX
 *
 * @description
 * First token of the subject of a restricted event.
 *
 * @type {string}
 */
export const DEFAULT_RESTRICTED_SUBJECT_PREFIX: string = 'restricted';

/**
 * Constant DEFAULT_DEAD_LETTER_SUBJECT_PREFIX
 *
 * @description
 * First token of the subject of a dead letter.
 *
 * @type {string}
 */
export const DEFAULT_DEAD_LETTER_SUBJECT_PREFIX: string = 'dlq';

/**
 * Constant DEFAULT_REBUILD_SUBJECT_PREFIX
 *
 * @description
 * First token of the subject of a rebuild item.
 *
 * @type {string}
 */
export const DEFAULT_REBUILD_SUBJECT_PREFIX: string = 'rebuild';

/**
 * Constant EVENTS_MAX_AGE_DAYS
 *
 * @description
 * How long the events stream and the restricted stream keep a message, in days, when the module
 * manages the streams.
 *
 * @type {number}
 */
export const EVENTS_MAX_AGE_DAYS: number = 7;

/**
 * Constant DUPLICATE_WINDOW_MS
 *
 * @description
 * How long the server remembers a `Nats-Msg-Id`, in milliseconds, when the module manages the
 * streams: two minutes. Past that window only the processed-ids table of a consumer protects it.
 *
 * @type {number}
 */
export const DUPLICATE_WINDOW_MS: number = 120_000;

/**
 * Constant ACK_WAIT_MS
 *
 * @description
 * How long a consumer may hold a message before the server redelivers it, in milliseconds.
 *
 * @type {number}
 */
export const ACK_WAIT_MS: number = 30_000;

/**
 * Constant DEFAULT_EVENTS_MAX_BYTES
 *
 * @description
 * Byte cap of the events stream when the module manages the streams: 1 GiB, as cadenway-ops.
 *
 * @type {number}
 */
export const DEFAULT_EVENTS_MAX_BYTES: number = 1_073_741_824;

/**
 * Constant DEFAULT_RESTRICTED_MAX_BYTES
 *
 * @description
 * Byte cap of the restricted stream when the module manages the streams: 64 MiB, as
 * cadenway-ops.
 *
 * @type {number}
 */
export const DEFAULT_RESTRICTED_MAX_BYTES: number = 67_108_864;

/**
 * Constant DEFAULT_DEAD_LETTER_MAX_BYTES
 *
 * @description
 * Byte cap of the dead-letter stream when the module manages the streams: 256 MiB, as
 * cadenway-ops.
 *
 * @type {number}
 */
export const DEFAULT_DEAD_LETTER_MAX_BYTES: number = 268_435_456;

/**
 * Constant DEFAULT_DEAD_LETTER_MAX_AGE_DAYS
 *
 * @description
 * How long the dead-letter stream keeps a message, in days, when the module manages the streams.
 *
 * @type {number}
 */
export const DEFAULT_DEAD_LETTER_MAX_AGE_DAYS: number = 30;

/**
 * Constant DEFAULT_PUBLISH_TIMEOUT_MS
 *
 * @description
 * How long a publish waits for the JetStream acknowledgement, in milliseconds.
 *
 * @type {number}
 */
export const DEFAULT_PUBLISH_TIMEOUT_MS: number = 5000;

/**
 * Constant DEFAULT_SHUTDOWN_TIMEOUT_MS
 *
 * @description
 * How long a shutdown waits for the running handlers, in milliseconds.
 *
 * @type {number}
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS: number = 10_000;

/**
 * Constant DEFAULT_REBUILD_TIMEOUT_MS
 *
 * @description
 * How long a rebuild emitter waits for the consumer to acknowledge one item, in milliseconds,
 * when rebuild items are acknowledged.
 *
 * @type {number}
 */
export const DEFAULT_REBUILD_TIMEOUT_MS: number = 30_000;

/**
 * Constant DEFAULT_HANDLER_TIMEOUT_MS
 *
 * @description
 * Time an event handler may take before its attempt is abandoned, in milliseconds: 25 seconds,
 * below the 30 seconds after which the server redelivers the message.
 *
 * @type {number}
 */
export const DEFAULT_HANDLER_TIMEOUT_MS: number = 25_000;

/**
 * Constant DEFAULT_REBUILD_MAX_PENDING
 *
 * @description
 * Number of rebuild items that may wait at the consumer of one entity before the next ones are
 * dropped.
 *
 * @type {number}
 */
export const DEFAULT_REBUILD_MAX_PENDING: number = 1000;

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
 * Constant DEFAULT_REBUILD_FLUSH_EVERY
 *
 * @description
 * Number of rebuild items sent between two flushes when rebuild items are not acknowledged.
 *
 * @type {number}
 */
export const DEFAULT_REBUILD_FLUSH_EVERY: number = 100;

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
 * @type {Readonly<Required<Omit<MessagingModuleOptions, 'servers' | 'user' | 'password'>>> & Pick<MessagingModuleOptions, 'user' | 'password'> & { readonly servers: readonly string[] }}
 */
export type ResolvedMessagingOptions = Readonly<
  Required<Omit<MessagingModuleOptions, 'servers' | 'user' | 'password'>>
> &
  Pick<MessagingModuleOptions, 'user' | 'password'> & { readonly servers: readonly string[] };

/**
 * Constant NAME_PATTERN
 *
 * @description
 * Shape of a service name and of a rebuild name: one subject token.
 *
 * @type {RegExp}
 */
const NAME_PATTERN: RegExp = /^[A-Za-z0-9_-]+$/u;

/**
 * Function parseServers
 *
 * @description
 * Turns the `servers` option into a list: a string is split on commas.
 *
 * @param {string | readonly string[]} servers - One URL, several separated by commas, or a list.
 * @returns {readonly string[]} The server URLs.
 * @throws {Error} When no server is left.
 */
export function parseServers(servers: string | readonly string[]): readonly string[] {
  const entries: readonly string[] = typeof servers === 'string' ? servers.split(',') : servers;
  const list: string[] = entries
    .map((entry: string) => entry.trim())
    .filter((entry: string) => entry !== '');
  if (list.length === 0) {
    throw new Error('MessagingModule needs at least one NATS server.');
  }
  return list;
}

/**
 * Function resolveMessagingOptions
 *
 * @description
 * Applies the documented default of every option left unset.
 *
 * @param {MessagingModuleOptions} options - Options given to `MessagingModule`.
 * @returns {ResolvedMessagingOptions} The complete options.
 * @throws {Error} When the service or rebuild name is not one token, no server is given, a subject prefix is not one token or two prefixes are equal, a count is not a positive integer, the handler timeout is not below the acknowledgement wait, or a restricted event name cannot be a subject.
 */
export function resolveMessagingOptions(options: MessagingModuleOptions): ResolvedMessagingOptions {
  if (!NAME_PATTERN.test(options.service)) {
    throw new Error(
      'MessagingModule needs a service name made of letters, digits, hyphens and underscores.',
    );
  }
  const rebuildName: string = options.rebuildName ?? options.user ?? options.service;
  if (!NAME_PATTERN.test(rebuildName)) {
    throw new Error(
      'The rebuild name of MessagingModule is made of letters, digits, hyphens and underscores.',
    );
  }
  const rebuildFlushEvery: number = options.rebuildFlushEvery ?? DEFAULT_REBUILD_FLUSH_EVERY;
  const rebuildMaxPending: number = options.rebuildMaxPending ?? DEFAULT_REBUILD_MAX_PENDING;
  for (const [label, count] of [
    ['rebuild flush count', rebuildFlushEvery],
    ['rebuild pending limit', rebuildMaxPending],
  ] as const) {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`The ${label} of MessagingModule is a positive integer.`);
    }
  }
  const handlerTimeoutMs: number = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  if (!(handlerTimeoutMs > 0 && handlerTimeoutMs < ACK_WAIT_MS)) {
    throw new Error(
      `The handler timeout of MessagingModule is positive and below the acknowledgement wait of ${String(ACK_WAIT_MS)} ms.`,
    );
  }
  const prefixes: Readonly<Record<string, string>> = {
    eventSubjectPrefix: options.eventSubjectPrefix ?? DEFAULT_EVENT_SUBJECT_PREFIX,
    restrictedSubjectPrefix: options.restrictedSubjectPrefix ?? DEFAULT_RESTRICTED_SUBJECT_PREFIX,
    deadLetterSubjectPrefix: options.deadLetterSubjectPrefix ?? DEFAULT_DEAD_LETTER_SUBJECT_PREFIX,
    rebuildSubjectPrefix: options.rebuildSubjectPrefix ?? DEFAULT_REBUILD_SUBJECT_PREFIX,
  };
  for (const [label, prefix] of Object.entries(prefixes)) {
    if (!NAME_PATTERN.test(prefix)) {
      throw new Error(
        `The ${label} of MessagingModule is one subject token: letters, digits, hyphens and underscores.`,
      );
    }
  }
  if (new Set(Object.values(prefixes)).size !== Object.keys(prefixes).length) {
    throw new Error(
      'The subject prefixes of MessagingModule (events, restricted events, dead letters, rebuilds) are pairwise distinct.',
    );
  }
  const eventSubjectPrefix: string = prefixes.eventSubjectPrefix ?? DEFAULT_EVENT_SUBJECT_PREFIX;
  const restrictedSubjectPrefix: string =
    prefixes.restrictedSubjectPrefix ?? DEFAULT_RESTRICTED_SUBJECT_PREFIX;
  const restrictedEvents: readonly string[] = [...(options.restrictedEvents ?? [])];
  for (const name of restrictedEvents) {
    eventSubject(restrictedSubjectPrefix, name);
  }
  return {
    service: options.service,
    servers: parseServers(options.servers),
    user: options.user,
    password: options.password,
    connectionName: options.connectionName ?? options.service,
    manageStreams: options.manageStreams ?? false,
    manageConsumers: options.manageConsumers ?? true,
    deadLetterWorker: options.deadLetterWorker ?? false,
    restrictedEvents,
    eventsStream: options.eventsStream ?? DEFAULT_EVENTS_STREAM,
    restrictedStream: options.restrictedStream ?? DEFAULT_RESTRICTED_STREAM,
    deadLetterStream: options.deadLetterStream ?? DEFAULT_DEAD_LETTER_STREAM,
    eventSubjectPrefix,
    restrictedSubjectPrefix,
    deadLetterSubjectPrefix: prefixes.deadLetterSubjectPrefix ?? DEFAULT_DEAD_LETTER_SUBJECT_PREFIX,
    rebuildSubjectPrefix: prefixes.rebuildSubjectPrefix ?? DEFAULT_REBUILD_SUBJECT_PREFIX,
    rebuildName,
    rebuildAcknowledgement: options.rebuildAcknowledgement ?? 'none',
    rebuildFlushEvery,
    rebuildMaxPending,
    handlerTimeoutMs,
    restrictedDeadLetterPayload: options.restrictedDeadLetterPayload ?? 'drop',
    eventsMaxBytes: options.eventsMaxBytes ?? DEFAULT_EVENTS_MAX_BYTES,
    restrictedMaxBytes: options.restrictedMaxBytes ?? DEFAULT_RESTRICTED_MAX_BYTES,
    deadLetterMaxBytes: options.deadLetterMaxBytes ?? DEFAULT_DEAD_LETTER_MAX_BYTES,
    deadLetterMaxAgeDays: options.deadLetterMaxAgeDays ?? DEFAULT_DEAD_LETTER_MAX_AGE_DAYS,
    publishTimeoutMs: options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    rebuildTimeoutMs: options.rebuildTimeoutMs ?? DEFAULT_REBUILD_TIMEOUT_MS,
  };
}

/**
 * Interface EventRoute
 *
 * @description
 * Where an event travels: its subject and the stream that stores it.
 */
export interface EventRoute {
  // #region Properties
  /**
   * Property subject
   *
   * @description
   * Subject of the event: `evt.<name>`, or `restricted.<name>` for a restricted event.
   *
   * @type {string}
   * @readonly
   */
  readonly subject: string;

  /**
   * Property stream
   *
   * @description
   * Stream that stores the event: the events stream, or the restricted stream.
   *
   * @type {string}
   * @readonly
   */
  readonly stream: string;

  /**
   * Property restricted
   *
   * @description
   * Whether the event is listed in `restrictedEvents`.
   *
   * @type {boolean}
   * @readonly
   */
  readonly restricted: boolean;
  // #endregion
}

/**
 * Function eventRoute
 *
 * @description
 * Derives the subject and the stream of an event from its name and the options of the module.
 * The publisher, the outbox relay and the consumers all route through it, so a restricted event
 * is published and consumed on the same subject.
 *
 * @param {ResolvedMessagingOptions} options - Options of the module.
 * @param {string} eventName - Name of the event in the contracts.
 * @returns {EventRoute} The subject and the stream.
 * @throws {Error} When the name cannot be part of a subject.
 */
export function eventRoute(options: ResolvedMessagingOptions, eventName: string): EventRoute {
  const restricted: boolean = options.restrictedEvents.includes(eventName);
  return restricted
    ? {
        subject: eventSubject(options.restrictedSubjectPrefix, eventName),
        stream: options.restrictedStream,
        restricted,
      }
    : {
        subject: eventSubject(options.eventSubjectPrefix, eventName),
        stream: options.eventsStream,
        restricted,
      };
}

/**
 * Interface MessagingConfig
 *
 * @description
 * Variables of an application that connects to NATS, as validated by `messagingConfigShape`.
 */
export interface MessagingConfig {
  // #region Properties
  /**
   * Property NATS_URL
   *
   * @description
   * NATS server URL, such as `nats://nats:4222`; several are separated by commas.
   *
   * @type {string}
   * @readonly
   */
  readonly NATS_URL: string;

  /**
   * Property NATS_USER
   *
   * @description
   * NATS user of the service, such as `task`. Optional: unset for an anonymous local connection.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly NATS_USER: string | undefined;

  /**
   * Property NATS_PASSWORD
   *
   * @description
   * Password of the NATS user. A secret. Optional.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly NATS_PASSWORD: string | undefined;
  // #endregion
}

/**
 * Constant NATS_URL_PATTERN
 *
 * @description
 * Shape of one NATS server URL: the `nats` or `tls` scheme, then a host and an optional port.
 *
 * @type {RegExp}
 */
const NATS_URL_PATTERN: RegExp = /^(?:nats|tls):\/\/[^\s/,]+$/u;

/**
 * Constant messagingConfigShape
 *
 * @description
 * Zod shape of `NATS_URL`, `NATS_USER` and `NATS_PASSWORD`. Spread it into the application
 * schema, then pass the values to `MessagingModule.forRootAsync`.
 *
 * @type {ConfigShape<MessagingConfig>}
 */
export const messagingConfigShape: ConfigShape<MessagingConfig> = {
  NATS_URL: z.string().refine(
    (value: string) => {
      const entries: string[] = value.split(',').map((entry: string) => entry.trim());
      return entries.every((entry: string) => NATS_URL_PATTERN.test(entry));
    },
    { error: 'Expected one or several comma-separated nats:// or tls:// URLs.' },
  ),
  NATS_USER: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/u, { error: 'Expected a NATS user name.' })
    .optional(),
  NATS_PASSWORD: z.string().min(1).optional(),
};
