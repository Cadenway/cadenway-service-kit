import { Module, type DynamicModule, type Provider } from '@nestjs/common';

import type { JobsRuntimeOptions } from '../../jobs/configuration/jobs-runtime-options.js';
import type { JobsTransaction } from '../../jobs/database/jobs-transaction.js';
import type {
  JobEnqueueOptions,
  JobEnqueueResult,
} from '../../jobs/enqueue/job-enqueue-options.js';
import type { JobHandler, JobWorkOptions } from '../../jobs/execution/job.js';
import type {
  JobScheduleOptions,
  JobUnscheduleOptions,
} from '../../jobs/scheduling/job-schedule-options.js';
import { JobProducer } from './job-producer.js';
import { JobScheduler } from './job-scheduler.js';
import { JobWorkerRegistry } from './job-worker-registry.js';
import {
  JOBS_RUNTIME_OPTIONS,
  type JobsRuntimeModuleAsyncOptions,
} from './jobs-runtime-module-options.js';
import { JobsRuntimeHost } from './jobs-runtime.host.js';

/**
 * Constant capabilityProviders
 *
 * @description
 * Provides each injectable capability through the runtime host that owns its lifecycle.
 *
 * @type {readonly Provider[]}
 */
const capabilityProviders: readonly Provider[] = [
  {
    provide: JobProducer,
    inject: [JobsRuntimeHost],
    useFactory: ({ runtime }: JobsRuntimeHost): JobProducer => ({
      enqueue: (
        tx: JobsTransaction,
        queue: string,
        payload: unknown,
        options: JobEnqueueOptions = {},
      ): Promise<JobEnqueueResult> => runtime.enqueue(tx, queue, payload, options),
    }),
  },
  {
    provide: JobWorkerRegistry,
    inject: [JobsRuntimeHost],
    useFactory: ({ runtime }: JobsRuntimeHost): JobWorkerRegistry => ({
      work: <TPayload>(
        queue: string,
        handler: JobHandler<TPayload>,
        options: JobWorkOptions = {},
      ): Promise<void> => runtime.work(queue, handler, options),
    }),
  },
  {
    provide: JobScheduler,
    inject: [JobsRuntimeHost],
    useFactory: ({ runtime }: JobsRuntimeHost): JobScheduler => ({
      schedule: (queue: string, cron: string, options: JobScheduleOptions): Promise<void> =>
        runtime.schedule(queue, cron, options),
      unschedule: (queue: string, options: JobUnscheduleOptions = {}): Promise<void> =>
        runtime.unschedule(queue, options),
    }),
  },
];

/**
 * Class JobsRuntimeModule
 *
 * @description
 * Global NestJS module for one explicitly configured jobs process.
 */
@Module({
  providers: [JobsRuntimeHost, ...capabilityProviders],
  exports: [JobProducer, JobWorkerRegistry, JobScheduler],
})
export class JobsRuntimeModule {
  // #region Methods
  /**
   * Method forRoot
   *
   * @description
   * Wires runtime capabilities with options available at module declaration.
   *
   * @param {JobsRuntimeOptions} options - Connection, queues and capabilities known at module declaration.
   * @returns {DynamicModule} Global module with providers for the jobs capabilities.
   */
  public static forRoot(options: JobsRuntimeOptions): DynamicModule {
    return {
      module: JobsRuntimeModule,
      global: true,
      providers: [{ provide: JOBS_RUNTIME_OPTIONS, useValue: options }],
    };
  }

  /**
   * Method forRootAsync
   *
   * @description
   * Wires runtime capabilities through an injected configuration factory.
   *
   * @param {JobsRuntimeModuleAsyncOptions} options - Factory and imports used to resolve the runtime configuration.
   * @returns {DynamicModule} Global module that supplies the jobs capability providers after resolving its options.
   */
  public static forRootAsync(options: JobsRuntimeModuleAsyncOptions): DynamicModule {
    return {
      module: JobsRuntimeModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        {
          provide: JOBS_RUNTIME_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ],
    };
  }
  // #endregion
}
