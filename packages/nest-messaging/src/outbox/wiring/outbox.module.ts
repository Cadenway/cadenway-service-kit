import {
  Module,
  type DynamicModule,
  type FactoryProvider,
  type ModuleMetadata,
  type Provider,
} from '@nestjs/common';

import { PostgresEventDeduplicationModule } from '../../consumer/postgres/postgres-event-deduplication.module.js';
import { LegacyOutboxNotice } from './legacy-outbox-notice.js';
import {
  OUTBOX_OPTIONS,
  resolveOutboxOptions,
  type OutboxModuleOptions,
  type ResolvedOutboxOptions,
} from './outbox-options.js';
import { OutboxRelay } from '../relay/outbox-relay.js';
import { OutboxWriter } from '../writer/outbox-writer.js';

/**
 * Interface OutboxModuleAsyncOptions
 *
 * @description
 * Configures the legacy outbox module from injected providers.
 */
export interface OutboxModuleAsyncOptions {
  // #region Properties
  /**
   * Property imports
   *
   * @description
   * Modules exporting non-global providers used by `useFactory`.
   *
   * @type {ModuleMetadata['imports'] | undefined}
   * @readonly
   */
  readonly imports?: ModuleMetadata['imports'];

  /**
   * Property inject
   *
   * @description
   * Provider tokens in the order accepted by `useFactory`.
   *
   * @type {FactoryProvider['inject'] | undefined}
   * @readonly
   */
  readonly inject?: FactoryProvider['inject'];

  /**
   * Property useFactory
   *
   * @description
   * Builds the relay settings from the injected providers.
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
 * Legacy providers shared by both module registration paths.
 *
 * @type {Provider[]}
 */
const OUTBOX_PROVIDERS: Provider[] = [LegacyOutboxNotice, OutboxWriter, OutboxRelay];

/**
 * Constant OUTBOX_EXPORTS
 *
 * @description
 * Providers the legacy module makes available outside its own composition root.
 *
 * @type {NonNullable<DynamicModule['exports']>}
 */
const OUTBOX_EXPORTS: NonNullable<DynamicModule['exports']> = [
  OutboxWriter,
  OutboxRelay,
  PostgresEventDeduplicationModule,
];

/**
 * Class OutboxModule
 *
 * @description
 * Registers the writer, legacy relay and PostgreSQL deduplicator globally. A durable handler's
 * committed work and its processed event ID share a transaction, so redelivery can skip it.
 *
 * The application imports `DatabaseModule` and `MessagingModule` and owns the table migrations.
 */
@Module({})
export class OutboxModule {
  // #region Methods
  /**
   * Method forRoot
   *
   * @description
   * Registers the global module with explicit or default relay settings.
   *
   * @param {OutboxModuleOptions} options - Legacy relay settings. Omitted values take the documented defaults.
   * @returns {DynamicModule} Global module with writer, relay and deduplication providers.
   * @throws When the batch size or poll interval is not positive.
   */
  public static forRoot(options: OutboxModuleOptions = {}): DynamicModule {
    return {
      module: OutboxModule,
      global: true,
      imports: [PostgresEventDeduplicationModule],
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
   * Registers the global module with relay settings built from injected providers.
   *
   * @param {OutboxModuleAsyncOptions} options - Factory and dependency tokens used to resolve legacy relay settings.
   * @returns {DynamicModule} Global module resolving its legacy settings from the injected dependencies.
   */
  public static forRootAsync(options: OutboxModuleAsyncOptions): DynamicModule {
    const factory: (
      ...dependencies: never[]
    ) => OutboxModuleOptions | Promise<OutboxModuleOptions> = options.useFactory;
    return {
      module: OutboxModule,
      global: true,
      imports: [PostgresEventDeduplicationModule, ...(options.imports ?? [])],
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
