/**
 * Constant HEALTH_OPTIONS
 *
 * @description
 * Injection token of the readiness options given to `HealthModule.forRoot`.
 *
 * @type {unique symbol}
 */
export const HEALTH_OPTIONS: unique symbol = Symbol('cadenway.health.options');

/**
 * Constant DEFAULT_INDICATOR_TIMEOUT_MS
 *
 * @description
 * Time one dependency check may take, in milliseconds: well under the 3 seconds a container
 * healthcheck waits.
 *
 * @type {number}
 */
export const DEFAULT_INDICATOR_TIMEOUT_MS: number = 1000;

/**
 * Interface HealthIndicator
 *
 * @description
 * One dependency the readiness route checks.
 */
export interface HealthIndicator {
  // #region Properties
  /**
   * Property name
   *
   * @description
   * Key of the dependency in the readiness body, such as `postgres`.
   *
   * @type {string}
   * @readonly
   */
  readonly name: string;
  // #endregion

  // #region Methods
  /**
   * Method check
   *
   * @description
   * Probes the dependency.
   *
   * @returns {Promise<void>} Resolves when the dependency answers; rejects otherwise.
   */
  check(): Promise<void>;
  // #endregion
}

/**
 * Interface HealthModuleOptions
 *
 * @description
 * Options of `HealthModule.forRoot`, or what the factory of `HealthModule.forRootAsync` returns.
 */
export interface HealthModuleOptions {
  // #region Properties
  /**
   * Property indicators
   *
   * @description
   * Dependencies the readiness route checks. Defaults to none: readiness then answers 200 as
   * soon as the application listens.
   *
   * @type {readonly HealthIndicator[] | undefined}
   * @readonly
   */
  readonly indicators?: readonly HealthIndicator[];

  /**
   * Property timeoutMs
   *
   * @description
   * Time one check may take before the dependency counts as down, in milliseconds. Defaults to
   * 1000.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly timeoutMs?: number;

  /**
   * Property shutdownDelayMs
   *
   * @description
   * Time the shutdown waits, once readiness answers 503, before the listener closes, in
   * milliseconds. Defaults to 0: the shutdown is not slowed. Set it to the time the router in
   * front needs to stop sending requests to a stopping instance, and keep it under the stop grace
   * period of the container. See the README: Traefik on Docker follows container events, not the
   * readiness route.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly shutdownDelayMs?: number;
  // #endregion
}

/**
 * Interface PostgresProbe
 *
 * @description
 * Part of a `pg` pool the PostgreSQL indicator uses.
 */
export interface PostgresProbe {
  // #region Methods
  /**
   * Method query
   *
   * @description
   * Runs one statement on a pooled connection.
   *
   * @param {string} text - SQL text.
   * @returns {Promise<unknown>} The result, ignored.
   */
  query(text: string): Promise<unknown>;
  // #endregion
}

/**
 * Interface RedisProbe
 *
 * @description
 * Part of an `ioredis` client the Redis indicator uses.
 */
export interface RedisProbe {
  // #region Methods
  /**
   * Method ping
   *
   * @description
   * Sends `PING`.
   *
   * @returns {Promise<unknown>} The reply, ignored.
   */
  ping(): Promise<unknown>;
  // #endregion
}

/**
 * Interface NatsProbe
 *
 * @description
 * Part of a NATS connection the NATS indicator uses. `@cadenway/nest-messaging` owns the
 * connection and hands it over; this package never imports a NATS client.
 */
export interface NatsProbe {
  // #region Methods
  /**
   * Method isClosed
   *
   * @description
   * Tells whether the connection was closed for good.
   *
   * @returns {boolean} `true` once closed.
   */
  isClosed(): boolean;

  /**
   * Method flush
   *
   * @description
   * Makes a round trip to the server.
   *
   * @returns {Promise<void>} Resolves when the server answered.
   */
  flush(): Promise<void>;
  // #endregion
}

/**
 * Function postgresIndicator
 *
 * @description
 * Builds the readiness indicator of PostgreSQL: `select 1` through the pool of the service.
 *
 * @param {PostgresProbe} pool - `pg` pool of the service (`DATABASE_POOL`).
 * @param {string} name - Key in the readiness body; defaults to `postgres`.
 * @returns {HealthIndicator} The indicator.
 */
export function postgresIndicator(pool: PostgresProbe, name: string = 'postgres'): HealthIndicator {
  return {
    name,
    check: async (): Promise<void> => {
      await pool.query('select 1');
    },
  };
}

/**
 * Function redisIndicator
 *
 * @description
 * Builds the readiness indicator of Redis: one `PING`.
 *
 * @param {RedisProbe} client - `ioredis` client of the application.
 * @param {string} name - Key in the readiness body; defaults to `redis`.
 * @returns {HealthIndicator} The indicator.
 */
export function redisIndicator(client: RedisProbe, name: string = 'redis'): HealthIndicator {
  return {
    name,
    check: async (): Promise<void> => {
      await client.ping();
    },
  };
}

/**
 * Function natsIndicator
 *
 * @description
 * Builds the readiness indicator of NATS: the connection is open and a flush makes the round
 * trip.
 *
 * @param {NatsProbe} connection - NATS connection, provided by `@cadenway/nest-messaging`.
 * @param {string} name - Key in the readiness body; defaults to `nats`.
 * @returns {HealthIndicator} The indicator.
 */
export function natsIndicator(connection: NatsProbe, name: string = 'nats'): HealthIndicator {
  return {
    name,
    check: async (): Promise<void> => {
      if (connection.isClosed()) {
        throw new Error('The NATS connection is closed.');
      }
      await connection.flush();
    },
  };
}
