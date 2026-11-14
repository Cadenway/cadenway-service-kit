import {
  Inject,
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import pg from 'pg';
import { z } from 'zod';

import type { ConfigShape } from '../config/base-config.js';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import {
  SystemTransactionRunner,
  TenantTransactionRunner,
  type DatabaseSchema,
} from './transaction-runner.js';

/**
 * Constant DATABASE_POOL
 *
 * @description
 * Injection token of the `pg` pool of the service. The transaction runners are the normal way
 * in; the pool is exposed for health checks and for closing.
 *
 * @type {symbol}
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
 * Interface DatabaseConfig
 *
 * @description
 * Variable of a service with a database, as validated by `databaseConfigShape`.
 */
export interface DatabaseConfig {
  // #region Properties
  /**
   * Property DATABASE_URL
   *
   * @description
   * Connection string of the service's own database, for the application role. A secret.
   *
   * @type {string}
   * @readonly
   */
  readonly DATABASE_URL: string;
  // #endregion
}

/**
 * Constant databaseConfigShape
 *
 * @description
 * Zod shape of `DATABASE_URL`, a `postgres://` or `postgresql://` URL. Spread it into the
 * application schema.
 *
 * @type {ConfigShape<DatabaseConfig>}
 */
export const databaseConfigShape: ConfigShape<DatabaseConfig> = {
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/u }),
};

/**
 * Interface DatabaseModuleOptions
 *
 * @description
 * Options of `DatabaseModule.forRoot`.
 */
export interface DatabaseModuleOptions<TSchema extends DatabaseSchema = Record<string, never>> {
  // #region Properties
  /**
   * Property connectionString
   *
   * @description
   * Connection string of the application role, usually `DATABASE_URL`.
   *
   * @type {string}
   * @readonly
   */
  readonly connectionString: string;

  /**
   * Property schema
   *
   * @description
   * Drizzle schema of the service, which enables its relational queries. Optional.
   *
   * @type {TSchema | undefined}
   * @readonly
   */
  readonly schema?: TSchema;

  /**
   * Property poolSize
   *
   * @description
   * Maximum number of connections. Defaults to 5.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly poolSize?: number;

  /**
   * Property connectionTimeoutMs
   *
   * @description
   * How long a transaction waits for a free connection, in milliseconds. Defaults to 5000.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly connectionTimeoutMs?: number;

  /**
   * Property applicationName
   *
   * @description
   * Name shown in `pg_stat_activity`, usually the service name. Unset by default.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly applicationName?: string;

  /**
   * Property idempotency
   *
   * @description
   * Registers the `Idempotency-Key` interceptor for the routes marked with `@Idempotent()`.
   * Defaults to `false`; it needs the `idempotency_keys` table in the service's migrations.
   *
   * @type {boolean | undefined}
   * @readonly
   */
  readonly idempotency?: boolean;
  // #endregion
}

/**
 * Class DatabasePoolLifecycle
 *
 * @description
 * Logs the errors of idle connections, which would otherwise crash the process, and closes the
 * pool when the application shuts down.
 */
@Injectable()
class DatabasePoolLifecycle implements OnApplicationShutdown {
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

/**
 * Class DatabaseModule
 *
 * @description
 * Gives a service its PostgreSQL pool and the two transaction runners, globally.
 *
 * Inject `TenantTransactionRunner` in the unit of work of a use case and
 * `SystemTransactionRunner` in the work that crosses organizations. Nothing else opens a
 * transaction. The module lives behind `@cadenway/nest-common/database` because `drizzle-orm`
 * and `pg` are optional peers: a gateway without a database never imports it.
 */
@Module({})
export class DatabaseModule {
  // #region Methods
  /**
   * Method forRoot
   *
   * @description
   * Creates the pool and the runners. No connection is opened before the first transaction.
   *
   * @param {DatabaseModuleOptions<TSchema>} options - Connection string, schema and pool settings.
   * @returns {DynamicModule} The global module.
   */
  public static forRoot<TSchema extends DatabaseSchema = Record<string, never>>(
    options: DatabaseModuleOptions<TSchema>,
  ): DynamicModule {
    const providers: Provider[] = [
      {
        provide: DATABASE_POOL,
        useFactory: (): pg.Pool =>
          new pg.Pool({
            connectionString: options.connectionString,
            max: options.poolSize ?? DEFAULT_POOL_SIZE,
            connectionTimeoutMillis: options.connectionTimeoutMs ?? 5000,
            ...(options.applicationName === undefined
              ? {}
              : { application_name: options.applicationName }),
          }),
      },
      {
        provide: TenantTransactionRunner,
        useFactory: (pool: pg.Pool): TenantTransactionRunner<TSchema> =>
          new TenantTransactionRunner<TSchema>(pool, options.schema),
        inject: [DATABASE_POOL],
      },
      {
        provide: SystemTransactionRunner,
        useFactory: (pool: pg.Pool): SystemTransactionRunner<TSchema> =>
          new SystemTransactionRunner<TSchema>(pool, options.schema),
        inject: [DATABASE_POOL],
      },
      DatabasePoolLifecycle,
    ];
    if (options.idempotency === true) {
      providers.push({ provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor });
    }
    return {
      module: DatabaseModule,
      global: true,
      providers,
      exports: [DATABASE_POOL, TenantTransactionRunner, SystemTransactionRunner],
    };
  }
  // #endregion
}
