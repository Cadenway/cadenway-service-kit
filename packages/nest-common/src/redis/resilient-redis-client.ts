import { Logger } from '@nestjs/common';
import { Redis, type Command, type RedisOptions } from 'ioredis';

/**
 * Type LegacyRedisOptions
 *
 * @description
 * ioredis options of a client that keeps the classic reply mapping (`legacy`, the ioredis
 * default), which `ResilientRedisClient` is typed with and `@socket.io/redis-adapter` reads.
 *
 * @type {Omit<RedisOptions, 'replyMapping'> & { replyMapping?: 'legacy' }}
 */
type LegacyRedisOptions = Omit<RedisOptions, 'replyMapping'> & { replyMapping?: 'legacy' };

/**
 * Interface ResilientRedisOptions
 *
 * @description
 * Options of `ResilientRedisClient`: those of ioredis, with the classic reply mapping, plus how
 * the client reports trouble.
 */
export interface ResilientRedisOptions extends Omit<RedisOptions, 'replyMapping'> {
  // #region Properties
  /**
   * Property replyMapping
   *
   * @description
   * Reply mapping of ioredis. Only `legacy`, its default, the replies the client is typed with.
   *
   * @type {'legacy' | undefined}
   * @readonly
   */
  readonly replyMapping?: 'legacy';

  /**
   * Property reportOutages
   *
   * @description
   * Logs the start of an outage once, at `warn`, with an error code at most, and the return of
   * the connection once, at `info`. Defaults to `true`. The publisher and subscriber of
   * `createPubSubClients` set `false`: they reach the same server as the main connection, which
   * reports for all of them. Either way the client listens to its `error` events, so ioredis
   * never prints them on the standard error.
   *
   * @type {boolean | undefined}
   * @readonly
   */
  readonly reportOutages?: boolean;

  /**
   * Property loggerContext
   *
   * @description
   * Context of the NestJS logger the client writes through. Defaults to `Redis`.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly loggerContext?: string;
  // #endregion
}

/**
 * Type PubSubRole
 *
 * @description
 * What one of the two connections of a pub/sub adapter does: `publisher` sends what this
 * instance broadcasts, `subscriber` receives what the others broadcast.
 *
 * @type {'publisher' | 'subscriber'}
 */
export type PubSubRole = 'publisher' | 'subscriber';

/**
 * Interface PubSubClients
 *
 * @description
 * The two connections `createPubSubClients` opens, such as those `@socket.io/redis-adapter`
 * takes.
 */
export interface PubSubClients {
  // #region Properties
  /**
   * Property publisher
   *
   * @description
   * Connection that publishes.
   *
   * @type {ResilientRedisClient}
   * @readonly
   */
  readonly publisher: ResilientRedisClient;

  /**
   * Property subscriber
   *
   * @description
   * Connection that subscribes.
   *
   * @type {ResilientRedisClient}
   * @readonly
   */
  readonly subscriber: ResilientRedisClient;
  // #endregion

  // #region Methods
  /**
   * Method shutDown
   *
   * @description
   * Closes both connections, as `ResilientRedisClient.shutDown` does.
   *
   * @returns {Promise<void>} Resolves once both are closed.
   */
  shutDown(): Promise<void>;
  // #endregion
}

/**
 * Function failureReason
 *
 * @description
 * Names why a command or a connection failed: the error code (`ECONNREFUSED`), the error name
 * otherwise. Never the message, which may carry an address, a key or a value.
 *
 * @param {unknown} error - Rejection reason or `error` event.
 * @returns {string} The code, the name, or `unknown error`.
 */
function failureReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'unknown error';
  }
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : error.name;
}

/**
 * Function redisOptionsOf
 *
 * @description
 * Removes the options of this package before the rest goes to ioredis, so the `options` of the
 * client, which `duplicate()` and `createPubSubClients` start from, hold ioredis options only.
 *
 * @param {ResilientRedisOptions} options - Options of the client.
 * @returns {LegacyRedisOptions} The ioredis options.
 */
function redisOptionsOf(options: ResilientRedisOptions): LegacyRedisOptions {
  const redis: { -readonly [Key in keyof ResilientRedisOptions]: ResilientRedisOptions[Key] } = {
    ...options,
  };
  delete redis.reportOutages;
  delete redis.loggerContext;
  return redis;
}

/**
 * Class ResilientRedisClient
 *
 * @description
 * ioredis client that cannot stop the process through a command nobody awaits.
 *
 * Libraries such as `@socket.io/redis-adapter` send commands (`PSUBSCRIBE`, `PUBLISH`,
 * `UNSUBSCRIBE`) and drop their promises. A command that fails (sent while Redis is unreachable
 * with the offline queue off, still queued when the retries run out, or when the connection
 * closes at shutdown) would then be an unhandled rejection, which stops Node. This client attaches
 * a handler to the promise of every command it sends. A failure while the connection is up is
 * logged at `warn` with the name of the command and an error code at most, never its arguments, a
 * key or a value; one caused by the shutdown is dropped silently, and one during an outage is
 * covered by the outage line. The caller receives the same promise and may still await it.
 *
 * Build it as an ioredis client: `new ResilientRedisClient(config.REDIS_URL, { connectionName })`
 * or `new ResilientRedisClient(options)`. Close it with `shutDown()`.
 */
export class ResilientRedisClient extends Redis {
  // #region Properties
  /**
   * Property failureLogger
   *
   * @description
   * Logger of the failed commands and of the outages; it never writes the address, which may
   * carry a password.
   *
   * @type {Logger}
   * @readonly
   */
  private readonly failureLogger: Logger;

  /**
   * Property reportsOutages
   *
   * @description
   * Whether this client logs the outages of its connection (`reportOutages`).
   *
   * @type {boolean}
   * @readonly
   */
  private readonly reportsOutages: boolean;

  /**
   * Property outageLogged
   *
   * @description
   * Whether the current outage has been logged, so a reconnection attempt every few hundred
   * milliseconds does not write a line each time.
   *
   * @type {boolean}
   */
  private outageLogged: boolean;

  /**
   * Property shuttingDown
   *
   * @description
   * Whether the client is being closed (`shutDown`, `quit` or `disconnect()`), after which a
   * failed command is expected and not logged.
   *
   * @type {boolean}
   */
  private shuttingDown: boolean;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Opens the connection as ioredis does (unless `lazyConnect`), without waiting for it.
   *
   * @param {string | ResilientRedisOptions} target - URL of the server, such as `REDIS_URL`, or the complete options.
   * @param {ResilientRedisOptions} options - Options added to a URL; ignored when `target` holds the options.
   * @constructor
   */
  public constructor(target: string | ResilientRedisOptions, options: ResilientRedisOptions = {}) {
    if (typeof target === 'string') {
      super(target, redisOptionsOf(options));
    } else {
      super(redisOptionsOf(target));
    }
    const settings: ResilientRedisOptions = typeof target === 'string' ? options : target;
    this.failureLogger = new Logger(settings.loggerContext ?? 'Redis');
    this.reportsOutages = settings.reportOutages ?? true;
    this.outageLogged = false;
    this.shuttingDown = false;
    // A refused or failed connection emits `error`; a dropped one emits `reconnecting`, even when
    // the next attempts hang instead of failing. Either starts an outage.
    this.on('error', (error: Error) => {
      this.reportOutage(failureReason(error));
    });
    this.on('reconnecting', () => {
      this.reportOutage('connection lost');
    });
    this.on('ready', () => {
      if (this.outageLogged) {
        this.failureLogger.log(this.fields({}), 'redis reachable again');
      }
      this.outageLogged = false;
    });
  }
  // #endregion

  // #region Methods
  /**
   * Method sendCommand
   *
   * @description
   * Sends a command as ioredis does, after attaching the handler that settles its promise.
   *
   * @param {Command} command - Command to send.
   * @param {Parameters<Redis['sendCommand']>[1]} stream - Stream of a pipeline, if any.
   * @returns {unknown} What ioredis returns: the promise of the command.
   */
  public override sendCommand(
    command: Command,
    stream?: Parameters<Redis['sendCommand']>[1],
  ): unknown {
    if (command.name === 'quit') {
      this.shuttingDown = true;
    }
    command.promise.catch((error: unknown) => {
      this.reportFailure(command.name, error);
    });
    return super.sendCommand(command, stream);
  }

  /**
   * Method disconnect
   *
   * @description
   * Closes the socket as ioredis does; without `reconnect`, marks the client as closing first, so
   * the commands it rejects are not logged.
   *
   * @param {boolean} reconnect - Whether ioredis reconnects afterwards. Defaults to `false`.
   * @returns {void}
   */
  public override disconnect(reconnect: boolean = false): void {
    if (!reconnect) {
      this.shuttingDown = true;
    }
    super.disconnect(reconnect);
  }

  /**
   * Method shutDown
   *
   * @description
   * Closes the connection when the application stops. A ready connection is closed with `QUIT`,
   * which lets the commands already sent complete; any other state, or a failed `QUIT`, closes the
   * socket at once, rejects the commands still queued (silently) and stops the reconnection
   * attempts.
   *
   * @returns {Promise<void>} Resolves once the connection is closed.
   */
  public async shutDown(): Promise<void> {
    this.shuttingDown = true;
    if (this.status === 'ready') {
      try {
        await this.quit();
        return;
      } catch {
        // The connection broke during the shutdown: there is nothing left to complete.
      }
    }
    this.disconnect();
  }

  /**
   * Method reportFailure
   *
   * @description
   * Logs a failed command with its name and an error code at most, when the connection is up and
   * the client is not closing. A command that fails while the connection is down (with the offline
   * queue off, or one of the commands ioredis itself sends at each reconnection attempt) is
   * covered by the one outage line of the main connection: a line per command would repeat it
   * every few hundred milliseconds.
   *
   * @param {string} name - Name of the command, such as `publish`.
   * @param {unknown} error - Rejection reason of the command.
   * @returns {void}
   */
  private reportFailure(name: string, error: unknown): void {
    if (this.shuttingDown || this.status !== 'ready') {
      return;
    }
    this.failureLogger.warn(
      this.fields({ command: name, reason: failureReason(error) }),
      'redis command failed',
    );
  }

  /**
   * Method reportOutage
   *
   * @description
   * Logs the start of an outage once, until the connection is ready again, when the client reports
   * outages and is not closing.
   *
   * @param {string} reason - Error code, such as `ECONNREFUSED`, or `connection lost`.
   * @returns {void}
   */
  private reportOutage(reason: string): void {
    if (!this.reportsOutages || this.shuttingDown || this.outageLogged) {
      return;
    }
    this.outageLogged = true;
    this.failureLogger.warn(this.fields({ reason }), 'redis unreachable');
  }

  /**
   * Method fields
   *
   * @description
   * Adds the name of the connection, when it has one, to the fields of a line.
   *
   * @param {Record<string, string>} extra - Fields of the line.
   * @returns {Record<string, string>} The fields, with `connection`.
   */
  private fields(extra: Record<string, string>): Record<string, string> {
    // ioredis fills an unset name with `null`, whatever its type says.
    const name: unknown = this.options.connectionName;
    return typeof name === 'string' && name !== '' ? { connection: name, ...extra } : extra;
  }
  // #endregion
}

/**
 * Function pubSubClientOptions
 *
 * @description
 * Derives the options of one pub/sub connection from those of the main connection, as
 * `duplicate()` does, with the overrides that keep the process up while Redis is unreachable:
 *
 * | Option                 | Value                   | Why                                                                                           |
 * | ---------------------- | ----------------------- | --------------------------------------------------------------------------------------------- |
 * | `enableOfflineQueue`   | `true`                  | The adapter subscribes as soon as it is created, usually before Redis answers: commands wait |
 * | `maxRetriesPerRequest` | `null`                  | A queued command waits for the connection without limit instead of failing during an outage  |
 * | `replyMapping`         | `legacy`                | The replies the adapter reads                                                                 |
 * | `connectionName`       | `<main name>-<role>`    | `CLIENT LIST` tells the connections apart; unset when the main connection has no name         |
 * | `reportOutages`        | `false`                 | The main connection reports outages for all of them                                           |
 *
 * Everything else (address, credentials, TLS, database, retry strategy) is the main connection's.
 *
 * @param {RedisOptions} base - Options of the main connection, usually `client.options`.
 * @param {PubSubRole} role - What the connection is for.
 * @returns {ResilientRedisOptions} The options of the pub/sub connection.
 */
export function pubSubClientOptions(base: RedisOptions, role: PubSubRole): ResilientRedisOptions {
  // ioredis fills an unset name with `null` in `client.options`, whatever its type says.
  const name: unknown = base.connectionName;
  return {
    ...base,
    ...(typeof name === 'string' && name !== '' ? { connectionName: `${name}-${role}` } : {}),
    replyMapping: 'legacy',
    enableOfflineQueue: true,
    maxRetriesPerRequest: null,
    reportOutages: false,
  };
}

/**
 * Function createPubSubClients
 *
 * @description
 * Opens the publisher and the subscriber of a pub/sub adapter from the options of the main
 * connection (`pubSubClientOptions`), as `ResilientRedisClient`s:
 * `createAdapter(clients.publisher, clients.subscriber)`. Close them with `clients.shutDown()`
 * before the main connection.
 *
 * @param {Redis} main - Main connection of the application, whose options both start from.
 * @returns {PubSubClients} The two connections, already connecting unless `lazyConnect` is set.
 */
export function createPubSubClients(main: Redis): PubSubClients {
  const publisher: ResilientRedisClient = new ResilientRedisClient(
    pubSubClientOptions(main.options, 'publisher'),
  );
  const subscriber: ResilientRedisClient = new ResilientRedisClient(
    pubSubClientOptions(main.options, 'subscriber'),
  );
  return {
    publisher,
    subscriber,
    shutDown: async (): Promise<void> => {
      await Promise.all([publisher.shutDown(), subscriber.shutDown()]);
    },
  };
}
