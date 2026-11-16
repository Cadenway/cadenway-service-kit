import { Module, type DynamicModule } from '@nestjs/common';

import type { JobsModuleOptions } from '../jobs/configuration/jobs-options.js';

/**
 * Constant CONFIGURATION
 *
 * @description
 * Injection token of the stand-in for the typed configuration of a service.
 *
 * @type {string}
 */
export const CONFIGURATION: string = 'TEST_CONFIGURATION';

/**
 * Class ConfigurationModule
 *
 * @description
 * Stand-in for the configuration module of a service in the integration tests: it exports the
 * module options that the factory of `JobsModule.forRootAsync` injects.
 */
@Module({})
export class ConfigurationModule {
  // #region Methods
  /**
   * Method with
   *
   * @description
   * Builds the module around the options of one scenario.
   *
   * @param {JobsModuleOptions} options - Options the factory will receive.
   * @returns {DynamicModule} A module exporting the options under `CONFIGURATION`.
   */
  public static with(options: JobsModuleOptions): DynamicModule {
    return {
      module: ConfigurationModule,
      providers: [{ provide: CONFIGURATION, useValue: options }],
      exports: [CONFIGURATION],
    };
  }
  // #endregion
}
