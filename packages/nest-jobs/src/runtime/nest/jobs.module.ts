import { Module, type DynamicModule } from '@nestjs/common';

import type { JobsModuleOptions } from '../../jobs/configuration/jobs-options.js';
import { JOBS_MODULE_OPTIONS, type JobsModuleAsyncOptions } from './jobs-module-options.js';
import { JobsService } from './jobs.service.js';

/**
 * Class JobsModule
 *
 * @description
 * Runtime module of the durable background jobs of a service. Import it once, in the root module,
 * through `forRoot` or `forRootAsync`; it is global, so `JobsService` can be injected anywhere.
 *
 * The module connects as the application role and never runs DDL: the pg-boss schema, the queues
 * and the grants come from `provisionJobs`, run beforehand as the migrator role. Start-up fails
 * with a `JobsNotProvisionedError` when that was not done. pg-boss stops with the application: call
 * `enableShutdownHooks()` so a termination signal reaches it.
 */
@Module({})
export class JobsModule {
  // #region Methods
  /**
   * Method forRoot
   *
   * @description
   * Registers the runtime with options known when the module is declared.
   *
   * @param {JobsModuleOptions} options - Application-role connection, queue declarations and
   * optional settings.
   * @returns {DynamicModule} A global module that provides `JobsService`.
   */
  public static forRoot(options: JobsModuleOptions): DynamicModule {
    return {
      module: JobsModule,
      global: true,
      providers: [{ provide: JOBS_MODULE_OPTIONS, useValue: options }, JobsService],
      exports: [JobsService],
    };
  }

  /**
   * Method forRootAsync
   *
   * @description
   * Registers the runtime with options built by a factory, typically from the typed configuration
   * of the service.
   *
   * @param {JobsModuleAsyncOptions} options - Factory of the module options and what it injects.
   * @returns {DynamicModule} A global module that provides `JobsService`.
   */
  public static forRootAsync(options: JobsModuleAsyncOptions): DynamicModule {
    return {
      module: JobsModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        {
          provide: JOBS_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        JobsService,
      ],
      exports: [JobsService],
    };
  }
  // #endregion
}
