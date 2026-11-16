import {
  Module,
  type DynamicModule,
  type FactoryProvider,
  type ModuleMetadata,
} from '@nestjs/common';

import { LEASED_OUTBOX_OPTIONS, LeasedOutboxRelay } from './leased-outbox-relay.js';
import {
  resolveOutboxRelayOptions,
  type OutboxRelayOptions,
  type ResolvedOutboxRelayOptions,
} from './outbox-relay-options.js';

/**
 * Interface OutboxRelayModuleAsyncOptions
 *
 * @description
 * Dependencies and factory for injected lease relay settings.
 */
export interface OutboxRelayModuleAsyncOptions {
  // #region Properties
  /**
   * Property imports
   *
   * @description
   * Modules exporting the factory's non-global dependencies.
   *
   * @type {ModuleMetadata['imports'] | undefined}
   * @readonly
   */
  readonly imports?: ModuleMetadata['imports'];

  /**
   * Property inject
   *
   * @description
   * Provider injection tokens for the factory.
   *
   * @type {FactoryProvider['inject'] | undefined}
   * @readonly
   */
  readonly inject?: FactoryProvider['inject'];

  /**
   * Property useFactory
   *
   * @description
   * Builds options with the injected dependencies.
   *
   * @type {(...dependencies: never[]) => OutboxRelayOptions | Promise<OutboxRelayOptions>}
   * @readonly
   */
  readonly useFactory: (
    ...dependencies: never[]
  ) => OutboxRelayOptions | Promise<OutboxRelayOptions>;
  // #endregion
}

/**
 * Class OutboxRelayModule
 *
 * @description
 * Wires only the lease-based relay and its retention work.
 */
@Module({})
export class OutboxRelayModule {
  // #region Methods
  /**
   * Method forRoot
   *
   * @description
   * Installs the relay with literal configuration.
   *
   * @param {OutboxRelayOptions} options - Explicit relay settings with component defaults for omitted fields.
   * @returns {DynamicModule} Global module exposing the lease-based relay.
   */
  public static forRoot(options: OutboxRelayOptions = {}): DynamicModule {
    return {
      module: OutboxRelayModule,
      global: true,
      providers: [
        { provide: LEASED_OUTBOX_OPTIONS, useValue: resolveOutboxRelayOptions(options) },
        LeasedOutboxRelay,
      ],
      exports: [LeasedOutboxRelay],
    };
  }

  /**
   * Method forRootAsync
   *
   * @description
   * Installs the relay with injected configuration.
   *
   * @param {OutboxRelayModuleAsyncOptions} options - Factory and dependency tokens used to resolve relay settings.
   * @returns {DynamicModule} Global module resolving relay settings from the injected dependencies.
   */
  public static forRootAsync(options: OutboxRelayModuleAsyncOptions): DynamicModule {
    return {
      module: OutboxRelayModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        {
          provide: LEASED_OUTBOX_OPTIONS,
          useFactory: async (...dependencies: never[]): Promise<ResolvedOutboxRelayOptions> =>
            resolveOutboxRelayOptions(await options.useFactory(...dependencies)),
          inject: options.inject ?? [],
        },
        LeasedOutboxRelay,
      ],
      exports: [LeasedOutboxRelay],
    };
  }
  // #endregion
}
