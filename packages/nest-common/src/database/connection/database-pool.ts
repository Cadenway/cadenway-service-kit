import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';

/**
 * Constant DATABASE_POOL
 *
 * @description
 * Injection token of the `pg` pool of the service. The transaction runners are the normal way
 * in; the pool is exposed for health checks and for closing.
 *
 * @type {unique symbol}
 */
export const DATABASE_POOL: unique symbol = Symbol('cadenway.database.pool');

/**
 * Constant DEFAULT_POOL_SIZE
 *
 * @description
 * Connections per service: twelve backends share one PostgreSQL and its default of 100.
 *
 * @type {number}
 */
export const DEFAULT_POOL_SIZE: number = 5;

/**
 * Function createPool
 *
 * @description
 * Creates the pool described by the options. No connection is opened before the first
 * transaction.
 *
 * @param {{ readonly connectionString: string; readonly poolSize?: number; readonly connectionTimeoutMs?: number; readonly applicationName?: string; }} options - Connection string and pool settings.
 * @returns {pg.Pool} The pool of the service.
 */
export function createPool(options: {
  readonly connectionString: string;
  readonly poolSize?: number;
  readonly connectionTimeoutMs?: number;
  readonly applicationName?: string;
}): pg.Pool {
  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.poolSize ?? DEFAULT_POOL_SIZE,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5000,
    // Lets the operating system notice a peer that vanished without closing.
    keepAlive: true,
    ...(options.applicationName === undefined ? {} : { application_name: options.applicationName }),
  });
}

/**
 * Class DatabasePoolLifecycle
 *
 * @description
 * Logs the errors of idle connections, which would otherwise crash the process, and closes the
 * pool when the application shuts down.
 */
@Injectable()
export class DatabasePoolLifecycle implements OnApplicationShutdown {
  // #region Properties
  /**
   * Property logger
   *
   * @description
   * Logger of the pool events.
   *
   * @type {Logger}
   * @readonly
   */
  private readonly logger: Logger = new Logger('DatabaseModule');
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Subscribes to the errors of idle connections.
   *
   * @param {pg.Pool} pool - Connection pool of the service.
   * @constructor
   */
  public constructor(@Inject(DATABASE_POOL) private readonly pool: pg.Pool) {
    this.pool.on('error', (error: Error) => {
      this.logger.error({ err: error }, 'idle database connection failed');
    });
  }
  // #endregion

  // #region Methods
  /**
   * Method onApplicationShutdown
   *
   * @description
   * Waits for the running transactions, then closes every connection.
   *
   * @returns {Promise<void>} Resolves once the pool is closed.
   */
  public async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
  // #endregion
}
