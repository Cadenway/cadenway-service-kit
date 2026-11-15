import { Module, type DynamicModule, type FactoryProvider, type Provider } from '@nestjs/common';

import { MessagingConnection } from './connection/messaging-connection.js';
import { EventConsumers } from './consumer/event-consumers.js';
import { DeadLetterWorker } from './dead-letter/dead-letter-worker.js';
import {
  MESSAGING_OPTIONS,
  resolveMessagingOptions,
  type MessagingModuleOptions,
  type ResolvedMessagingOptions,
} from './messaging-options.js';
import { EventPublisher } from './publisher/event-publisher.js';
import { RebuildEmitter } from './rebuild/rebuild-emitter.js';

/**
 * Interface MessagingModuleAsyncOptions
 *
 * @description
 * Options of `MessagingModule.forRootAsync`, for options built from injected providers such as
 * the validated configuration.
 */
export interface MessagingModuleAsyncOptions {
  // #region Properties
  /**
   * Property inject
   *
   * @description
   * Tokens of the providers handed to `useFactory`, in order. They must be visible globally.
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
   * @type {(...dependencies: never[]) => MessagingModuleOptions | Promise<MessagingModuleOptions>}
   * @readonly
   */
  readonly useFactory: (
    ...dependencies: never[]
  ) => MessagingModuleOptions | Promise<MessagingModuleOptions>;
  // #endregion
}

/**
 * Constant SHARED_PROVIDERS
 *
 * @description
 * Providers of the module that do not depend on how the options are given. The connection is
 * opened by an asynchronous factory, so it is ready before any other provider is used.
 *
 * @type {Provider[]}
 */
const SHARED_PROVIDERS: Provider[] = [
  {
    provide: MessagingConnection,
    useFactory: (options: ResolvedMessagingOptions): Promise<MessagingConnection> =>
      MessagingConnection.open(options),
    inject: [MESSAGING_OPTIONS],
  },
  EventPublisher,
  EventConsumers,
  RebuildEmitter,
  DeadLetterWorker,
];

/**
 * Constant SHARED_EXPORTS
 *
 * @description
 * What the module makes injectable in the whole application.
 *
 * @type {NonNullable<DynamicModule['exports']>}
 */
const SHARED_EXPORTS: NonNullable<DynamicModule['exports']> = [
  MESSAGING_OPTIONS,
  MessagingConnection,
  EventPublisher,
  EventConsumers,
  RebuildEmitter,
];

/**
 * Class MessagingModule
 *
 * @description
 * Gives an application its NATS JetStream connection, globally, with the event publisher, the
 * event consumers, the rebuild emitter and, when enabled, the dead-letter worker.
 *
 * The module needs no database: a gateway imports this entry point only. A service with a
 * database adds `OutboxModule` from `@cadenway/nest-messaging/outbox`.
 *
 * The application waits for its first NATS connection while it starts. On shutdown the
 * consumers stop first and the connection is drained last: enable the shutdown hooks of NestJS,
 * as `createApplication` of `@cadenway/nest-common` does.
 */
@Module({})
export class MessagingModule {
  // #region Methods
  /**
   * Method forRoot
   *
   * @description
   * Registers the module with literal options.
   *
   * @param {MessagingModuleOptions} options - Service name, servers and optional settings.
   * @returns {DynamicModule} The global module.
   * @throws {Error} When the service name or the servers are missing.
   */
  public static forRoot(options: MessagingModuleOptions): DynamicModule {
    const resolved: ResolvedMessagingOptions = resolveMessagingOptions(options);
    return {
      module: MessagingModule,
      global: true,
      providers: [{ provide: MESSAGING_OPTIONS, useValue: resolved }, ...SHARED_PROVIDERS],
      exports: SHARED_EXPORTS,
    };
  }

  /**
   * Method forRootAsync
   *
   * @description
   * Same as `forRoot`, with options built from injected providers:
   * `MessagingModule.forRootAsync({ inject: [CONFIG], useFactory: (config) => ({ service: 'task-service', servers: config.NATS_URL, user: config.NATS_USER, password: config.NATS_PASSWORD }) })`.
   *
   * @param {MessagingModuleAsyncOptions} options - Injection tokens and the factory of the options.
   * @returns {DynamicModule} The global module.
   */
  public static forRootAsync(options: MessagingModuleAsyncOptions): DynamicModule {
    const factory: (
      ...dependencies: never[]
    ) => MessagingModuleOptions | Promise<MessagingModuleOptions> = options.useFactory;
    return {
      module: MessagingModule,
      global: true,
      providers: [
        {
          provide: MESSAGING_OPTIONS,
          useFactory: async (...dependencies: never[]): Promise<ResolvedMessagingOptions> =>
            resolveMessagingOptions(await factory(...dependencies)),
          inject: options.inject ?? [],
        },
        ...SHARED_PROVIDERS,
      ],
      exports: SHARED_EXPORTS,
    };
  }
  // #endregion
}
