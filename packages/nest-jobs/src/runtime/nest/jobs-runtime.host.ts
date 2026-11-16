import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';

import {
  resolveJobsRuntimeOptions,
  type JobsRuntimeOptions,
} from '../../jobs/configuration/jobs-runtime-options.js';
import { JobsRuntime } from '../lifecycle/jobs-runtime.js';
import { JOBS_RUNTIME_OPTIONS } from './jobs-runtime-module-options.js';

/**
 * Class JobsRuntimeHost
 *
 * @description
 * Owns the Nest lifecycle of the runtime shared by the configured job capabilities.
 */
@Injectable()
export class JobsRuntimeHost implements OnModuleInit, BeforeApplicationShutdown {
  // #region Properties
  /**
   * Property runtime
   *
   * @description
   * Runtime used by all capability providers in this module.
   *
   * @type {JobsRuntime}
   * @readonly
   */
  public readonly runtime: JobsRuntime;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Resolves configuration before opening any connection.
   *
   * @param {JobsRuntimeOptions} options - Injected options selecting the capabilities enabled in this process.
   * @constructor
   */
  public constructor(@Inject(JOBS_RUNTIME_OPTIONS) options: JobsRuntimeOptions) {
    this.runtime = new JobsRuntime(resolveJobsRuntimeOptions(options), new Logger('JobsRuntime'));
  }
  // #endregion

  // #region Methods
  /**
   * Method onModuleInit
   *
   * @description
   * Validates the database before enabling the configured job capabilities.
   *
   * @returns {Promise<void>} Resolves after provisioning checks and activation of the configured capabilities.
   */
  public async onModuleInit(): Promise<void> {
    await this.runtime.start();
  }

  /**
   * Method beforeApplicationShutdown
   *
   * @description
   * Stops the runtime before Nest closes application resources.
   *
   * @returns {Promise<void>} Resolves after the runtime finishes shutdown.
   */
  public async beforeApplicationShutdown(): Promise<void> {
    await this.runtime.stop();
  }
  // #endregion
}
