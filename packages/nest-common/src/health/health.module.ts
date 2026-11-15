import {
  Module,
  type DynamicModule,
  type FactoryProvider,
  type ModuleMetadata,
} from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { HEALTH_OPTIONS, type HealthModuleOptions } from './health-indicators.js';
import { HealthController } from './health.controller.js';

/**
 * Interface HealthModuleAsyncOptions
 *
 * @description
 * Options of `HealthModule.forRootAsync`, for indicators built from injected providers such as
 * the database pool.
 */
export interface HealthModuleAsyncOptions {
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
   * Tokens of the providers handed to `useFactory`, in order. They must be global or exported by
   * a module listed in `imports`.
   *
   * @type {FactoryProvider['inject']}
   * @readonly
   */
  readonly inject?: FactoryProvider['inject'];

  /**
   * Property useFactory
   *
   * @description
   * Builds the readiness options from the injected providers.
   *
   * @type {(...dependencies: never[]) => HealthModuleOptions | Promise<HealthModuleOptions>}
   * @readonly
   */
  readonly useFactory: (
    ...dependencies: never[]
  ) => HealthModuleOptions | Promise<HealthModuleOptions>;
  // #endregion
}

/**
 * Class HealthModule
 *
 * @description
 * Adds the `GET /health/live` and `GET /health/ready` routes to a service or a gateway.
 *
 * Imported as the bare class, it takes no option: both routes answer 200 with the Terminus body
 * (`{ status: 'ok', info: {}, error: {}, details: {} }`) and readiness checks no dependency.
 * `HealthModule.forRoot({ indicators })` makes readiness check the dependencies of the
 * application; liveness never does. In every form, readiness answers 503 once the application
 * starts shutting down.
 *
 * The per-probe error line of Terminus is turned off: the controller logs changes of the
 * readiness state instead, so an outage writes one line, not one per probe.
 *
 * The module is the only public entry of the health feature.
 */
@Module({ imports: [TerminusModule.forRoot({ logger: false })], controllers: [HealthController] })
export class HealthModule {
  // #region Methods
  /**
   * Method forRoot
   *
   * @description
   * Registers the health routes with dependency indicators for readiness.
   *
   * @param {HealthModuleOptions} options - Indicators, their timeout and the shutdown delay.
   * @returns {DynamicModule} The module to import in the application module.
   */
  public static forRoot(options: HealthModuleOptions): DynamicModule {
    return {
      module: HealthModule,
      providers: [{ provide: HEALTH_OPTIONS, useValue: options }],
    };
  }

  /**
   * Method forRootAsync
   *
   * @description
   * Same as `forRoot`, with indicators built from injected providers:
   * `HealthModule.forRootAsync({ inject: [DATABASE_POOL], useFactory: (pool) => ({ indicators: [postgresIndicator(pool)] }) })`.
   * A provider that is not global is reached by listing its module in `imports`.
   *
   * @param {HealthModuleAsyncOptions} options - Imports, injection tokens and the factory of the options.
   * @returns {DynamicModule} The module to import in the application module.
   */
  public static forRootAsync(options: HealthModuleAsyncOptions): DynamicModule {
    return {
      module: HealthModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: HEALTH_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ],
    };
  }
  // #endregion
}
