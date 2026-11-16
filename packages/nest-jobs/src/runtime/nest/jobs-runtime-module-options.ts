import type { FactoryProvider, ModuleMetadata } from '@nestjs/common';

import type { JobsRuntimeOptions } from '../../jobs/configuration/jobs-runtime-options.js';

/**
 * Constant JOBS_RUNTIME_OPTIONS
 *
 * @description
 * Internal injection token for the explicitly configured runtime.
 *
 * @type {unique symbol}
 */
export const JOBS_RUNTIME_OPTIONS: unique symbol = Symbol('JOBS_RUNTIME_OPTIONS');

/**
 * Interface JobsRuntimeModuleAsyncOptions
 *
 * @description
 * Options for wiring capabilities through an application configuration provider.
 */
export interface JobsRuntimeModuleAsyncOptions {
  // #region Properties
  /**
   * Property imports
   *
   * @description
   * Modules exporting the dependencies used by the options factory.
   *
   * @type {ModuleMetadata['imports']}
   * @readonly
   */
  readonly imports?: ModuleMetadata['imports'];

  /**
   * Property inject
   *
   * @description
   * Dependencies passed to the options factory.
   *
   * @type {FactoryProvider<JobsRuntimeOptions>['inject']}
   * @readonly
   */
  readonly inject?: FactoryProvider<JobsRuntimeOptions>['inject'];

  /**
   * Property useFactory
   *
   * @description
   * Returns the runtime options and the capabilities of this process.
   *
   * @type {FactoryProvider<JobsRuntimeOptions>['useFactory']}
   * @readonly
   */
  readonly useFactory: FactoryProvider<JobsRuntimeOptions>['useFactory'];
  // #endregion
}
