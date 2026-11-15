import {
  Module,
  type DynamicModule,
  type FactoryProvider,
  type ModuleMetadata,
  type Provider,
} from '@nestjs/common';

import { EVENT_DEDUPLICATOR } from '../consumer/event-deduplicator.js';
import {
  OUTBOX_OPTIONS,
  resolveOutboxOptions,
  type OutboxModuleOptions,
  type ResolvedOutboxOptions,
} from './outbox-options.js';
import { OutboxRelay } from './outbox-relay.js';
import { OutboxWriter } from './outbox-writer.js';
import { PostgresEventDeduplicator } from './postgres-event-deduplicator.js';

/**
 * Interface OutboxModuleAsyncOptions
 *
 * @description
 * Options of `OutboxModule.forRootAsync`, for options built from injected providers such as the
 * validated configuration.
 */
export interface OutboxModuleAsyncOptions {
  // #region Properties
  /**
   * Property imports
   *
   * @description
   * Modules whose exported providers `useFactory` injects, when they are not global.
   *
   * @type {ModuleMetadata['imports']}
   * @readonly
   */
  readonly imports?: ModuleMetadata['imports'];

  /**
   * Property inject
   *
   * @description
   * Tokens of the providers handed to `useFactory`, in order: global providers, or providers
   * exported by `imports`.
   *
   * @type {FactoryProvider['inject']}
   * @readonly
   */
  readonly inject?: FactoryProvider['inject'];

  /**
   * Property useFactory
   *
   * @description
   * Builds the options of the module from the injected providers.
   *
   * @type {(...dependencies: never[]) => OutboxModuleOptions | Promise<OutboxModuleOptions>}
   * @readonly
   */
  readonly useFactory: (
    ...dependencies: never[]
  ) => OutboxModuleOptions | Promise<OutboxModuleOptions>;
  // #endregion
}

/**
 * Constant OUTBOX_PROVIDERS
 *
 * @description
 * Providers of the module that do not depend on how the options are given.
 *
 * @type {Provider[]}
 */
const OUTBOX_PROVIDERS: Provider[] = [
  OutboxWriter,
  OutboxRelay,
  PostgresEventDeduplicator,
  { provide: EVENT_DEDUPLICATOR, useExisting: PostgresEventDeduplicator },
];

/**
 * Constant OUTBOX_EXPORTS
 *
 * @description
 * What the module makes injectable in the whole application.
 *
 * @type {NonNullable<DynamicModule['exports']>}
 */
const OUTBOX_EXPORTS: NonNullable<DynamicModule['exports']> = [
  OutboxWriter,
  OutboxRelay,
  EVENT_DEDUPLICATOR,
];

/**
 * Class OutboxModule
 *
 * @description
 * Gives a service with a database the outbox writer, the relay and the PostgreSQL deduplicator,
 * globally. Importing it registers the deduplicator as the deduplicator of the application:
 * every handler registered with `EventConsumers` then runs at most once per event, in a
 * transaction.
 *
 * It requires `DatabaseModule` of `@cadenway/nest-common/database`, for the two transaction
 * runners, and `MessagingModule` of this package, both imported by the application. The three
 * tables it uses come from the migrations of the service: see the README.
 */
@Module({})
export class OutboxModule {
  // #region Methods
  /**
   * Method forRoot
   *
   * @description
   * Registers the module.
   *
   * @param {OutboxModuleOptions} options - Relay settings; every option has a default.
   * @returns {DynamicModule} The global module.
   * @throws {Error} When the batch size or the poll interval is not positive.
   */
  public static forRoot(options: OutboxModuleOptions = {}): DynamicModule {
    return {
      module: OutboxModule,
      global: true,
      providers: [
        { provide: OUTBOX_OPTIONS, useValue: resolveOutboxOptions(options) },
        ...OUTBOX_PROVIDERS,
      ],
      exports: OUTBOX_EXPORTS,
    };
  }

  /**
   * Method forRootAsync
   *
   * @description
   * Same as `forRoot`, with options built from injected providers:
   * `OutboxModule.forRootAsync({ inject: [CONFIG], useFactory: (config) => ({ relay: config.OUTBOX_RELAY }) })`.
   *
   * @param {OutboxModuleAsyncOptions} options - Imports, injection tokens and the factory of the options.
   * @returns {DynamicModule} The global module.
   */
  public static forRootAsync(options: OutboxModuleAsyncOptions): DynamicModule {
    const factory: (
      ...dependencies: never[]
    ) => OutboxModuleOptions | Promise<OutboxModuleOptions> = options.useFactory;
    return {
      module: OutboxModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        {
          provide: OUTBOX_OPTIONS,
          useFactory: async (...dependencies: never[]): Promise<ResolvedOutboxOptions> =>
            resolveOutboxOptions(await factory(...dependencies)),
          inject: options.inject ?? [],
        },
        ...OUTBOX_PROVIDERS,
      ],
      exports: OUTBOX_EXPORTS,
    };
  }
  // #endregion
}
