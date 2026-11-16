import type { FactoryProvider, ModuleMetadata } from '@nestjs/common';

import type { JobsRuntimeOptions } from '../../jobs/configuration/jobs-runtime-options.js';

/** Internal injection token for the explicitly configured runtime. */
export const JOBS_RUNTIME_OPTIONS: unique symbol = Symbol('JOBS_RUNTIME_OPTIONS');

/** Options for wiring capabilities through an application configuration provider. */
export interface JobsRuntimeModuleAsyncOptions {
  // #region Properties
  /** Modules exporting the dependencies used by the options factory. */
  readonly imports?: ModuleMetadata['imports'];

  /** Dependencies passed to the options factory. */
  readonly inject?: FactoryProvider<JobsRuntimeOptions>['inject'];

  /** Returns the runtime options and the capabilities of this process. */
  readonly useFactory: FactoryProvider<JobsRuntimeOptions>['useFactory'];
  // #endregion
}
