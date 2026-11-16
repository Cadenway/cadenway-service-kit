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

/** Dependencies and factory for injected lease relay settings. */
export interface OutboxRelayModuleAsyncOptions {
  // #region Properties
  /** Modules exporting the factory's non-global dependencies. */
  readonly imports?: ModuleMetadata['imports'];

  /** Provider injection tokens for the factory. */
  readonly inject?: FactoryProvider['inject'];

  /** Builds options with the injected dependencies. */
  readonly useFactory: (
    ...dependencies: never[]
  ) => OutboxRelayOptions | Promise<OutboxRelayOptions>;
  // #endregion
}

/** Wires only the lease-based relay and its retention work. */
@Module({})
export class OutboxRelayModule {
  // #region Methods
  /** Installs the relay with literal configuration. */
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

  /** Installs the relay with injected configuration. */
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
