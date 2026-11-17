import type { FactoryProvider, ModuleMetadata } from '@nestjs/common';

import type { JobsModuleOptions } from '../../jobs/configuration/jobs-options.js';

/**
 * Constant JOBS_MODULE_OPTIONS
 *
 * @description
 * Injection token of the options given to `JobsModule`. Internal to the package.
 *
 * @type {unique symbol}
 */
export const JOBS_MODULE_OPTIONS: unique symbol = Symbol('JOBS_MODULE_OPTIONS');

/**
 * Interface JobsModuleAsyncOptions
 *
 * @description
 * Options of `JobsModule.forRootAsync`: the module options come from a factory that may inject
 * providers, typically the typed configuration of the service.
 */
export interface JobsModuleAsyncOptions {
  // #region Properties
  /**
   * Property imports
   *
   * @description
   * Modules that export the providers the factory injects. Defaults to none.
   *
   * @type {ModuleMetadata['imports']}
   * @readonly
   */
  readonly imports?: ModuleMetadata['imports'];

  /**
   * Property inject
   *
   * @description
   * Tokens of the providers passed to the factory, in order. Defaults to none.
   *
   * @type {FactoryProvider<JobsModuleOptions>['inject']}
   * @readonly
   */
  readonly inject?: FactoryProvider<JobsModuleOptions>['inject'];

  /**
   * Property useFactory
   *
   * @description
   * Builds the module options, synchronously or not.
   *
   * @type {FactoryProvider<JobsModuleOptions>['useFactory']}
   * @readonly
   */
  readonly useFactory: FactoryProvider<JobsModuleOptions>['useFactory'];
  // #endregion
}
