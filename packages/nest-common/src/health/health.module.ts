import { Module, type DynamicModule, type FactoryProvider } from '@nestjs/common';
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
 * application; liveness never does.
 *
 * The module is the only public entry of the health feature.
 */
@Module({ imports: [TerminusModule], controllers: [HealthController] })
export class HealthModule {
  // #region Methods
  /**
   * Method forRoot
   *
   * @description
   * Registers the health routes with dependency indicators for readiness.
   *
   * @param {HealthModuleOptions} options - Indicators and their timeout.
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
   *
   * @param {HealthModuleAsyncOptions} options - Injection tokens and the factory of the options.
   * @returns {DynamicModule} The module to import in the application module.
   */
  public static forRootAsync(options: HealthModuleAsyncOptions): DynamicModule {
    return {
      module: HealthModule,
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
