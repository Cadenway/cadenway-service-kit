import {
  Inject,
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type FactoryProvider,
  type ModuleMetadata,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
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
 * Options of `DatabaseModule.forRoot`, or what the factory of `DatabaseModule.forRootAsync`
 * returns.
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
 * Interface DatabaseModuleAsyncOptions
 *
 * @description
 * Options of `DatabaseModule.forRootAsync`, for options built from injected providers such as
 * the validated configuration.
 */
export interface DatabaseModuleAsyncOptions<
  TSchema extends DatabaseSchema = Record<string, never>,
> {
  // #region Properties
  /**
   * Property imports
   *
   * @description
   * Modules exporting the providers named in `inject`, when they are not global.
   *
   * @type {ModuleMetadata['imports']}
   * @readonly
   */
  readonly imports?: ModuleMetadata['imports'];

  /**
   * Property inject
   *
   * @description
   * Tokens of the providers handed to `useFactory`, in order, such as `CONFIG`.
   *
   * @type {FactoryProvider['inject']}
   * @readonly
   */
  readonly inject?: FactoryProvider['inject'];

  /**
   * Property useFactory
   *
   * @description
   * Builds the options of the module from the injected providers, when the application is
   * created.
   *
   * @type {(...dependencies: never[]) => DatabaseModuleOptions<TSchema> | Promise<DatabaseModuleOptions<TSchema>>}
   * @readonly
   */
  readonly useFactory: (
    ...dependencies: never[]
  ) => DatabaseModuleOptions<TSchema> | Promise<DatabaseModuleOptions<TSchema>>;
  // #endregion
}

/**
 * Constant DATABASE_OPTIONS
 *
 * @description
 * Injection token of the resolved options of the module, internal to it.
 *
 * @type {symbol}
 */
const DATABASE_OPTIONS: unique symbol = Symbol('cadenway.database.options');

/**
 * Function createPool
 *
 * @description
 * Creates the pool described by the options. No connection is opened before the first
 * transaction.
 *
 * @param {DatabaseModuleOptions<DatabaseSchema>} options - Resolved options of the module.
 * @returns {pg.Pool} The pool of the service.
 */
function createPool(options: DatabaseModuleOptions<DatabaseSchema>): pg.Pool {
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
 * Function databaseProviders
 *
 * @description
 * Builds the providers shared by `forRoot` and `forRootAsync`, all reading the options from
 * `DATABASE_OPTIONS`: the pool, the two runners and the pool lifecycle.
 *
 * @returns {Provider[]} The providers, without the options and without the interceptor.
 */
function databaseProviders(): Provider[] {
  return [
    { provide: DATABASE_POOL, useFactory: createPool, inject: [DATABASE_OPTIONS] },
    {
      provide: TenantTransactionRunner,
      useFactory: (
        pool: pg.Pool,
        options: DatabaseModuleOptions<DatabaseSchema>,
      ): TenantTransactionRunner<DatabaseSchema> =>
        new TenantTransactionRunner<DatabaseSchema>(pool, options.schema),
      inject: [DATABASE_POOL, DATABASE_OPTIONS],
    },
    {
      provide: SystemTransactionRunner,
      useFactory: (
        pool: pg.Pool,
        options: DatabaseModuleOptions<DatabaseSchema>,
      ): SystemTransactionRunner<DatabaseSchema> =>
        new SystemTransactionRunner<DatabaseSchema>(pool, options.schema),
      inject: [DATABASE_POOL, DATABASE_OPTIONS],
    },
    DatabasePoolLifecycle,
  ];
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
      { provide: DATABASE_OPTIONS, useValue: options },
      ...databaseProviders(),
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

  /**
   * Method forRootAsync
   *
   * @description
   * Same as `forRoot`, with the options built when the application is created, from injected
   * providers: `DatabaseModule.forRootAsync({ inject: [CONFIG], useFactory: (config) => ({ connectionString: config.DATABASE_URL }) })`.
   * Importing the module therefore reads no configuration.
   *
   * The `Idempotency-Key` interceptor is registered when the resolved options set
   * `idempotency: true`, exactly as with `forRoot`: the global interceptor provider is always
   * declared, and its factory returns `null` when idempotency is off, which NestJS skips when it
   * applies the global interceptors.
   *
   * @param {DatabaseModuleAsyncOptions<TSchema>} options - Imports, injection tokens and the factory of the options.
   * @returns {DynamicModule} The global module.
   */
  public static forRootAsync<TSchema extends DatabaseSchema = Record<string, never>>(
    options: DatabaseModuleAsyncOptions<TSchema>,
  ): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        { provide: DATABASE_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] },
        ...databaseProviders(),
        {
          provide: APP_INTERCEPTOR,
          useFactory: (
            resolved: DatabaseModuleOptions<DatabaseSchema>,
            tenant: TenantTransactionRunner<DatabaseSchema>,
            system: SystemTransactionRunner<DatabaseSchema>,
            reflector: Reflector,
          ): IdempotencyInterceptor | null =>
            resolved.idempotency === true
              ? new IdempotencyInterceptor(tenant, system, reflector)
              : null,
          inject: [DATABASE_OPTIONS, TenantTransactionRunner, SystemTransactionRunner, Reflector],
        },
      ],
      exports: [DATABASE_POOL, TenantTransactionRunner, SystemTransactionRunner],
    };
  }
  // #endregion
}
