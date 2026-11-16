import {
  Inject,
  Injectable,
  Logger,
  Module,
  type BeforeApplicationShutdown,
  type DynamicModule,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common';

import {
  resolveJobsRuntimeOptions,
  type JobsRuntimeOptions,
} from '../../jobs/configuration/jobs-runtime-options.js';
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
import { JobsRuntime } from '../lifecycle/jobs-runtime.js';
import { JobProducer, JobScheduler, JobWorkerRegistry } from './job-capabilities.js';
import {
  JOBS_RUNTIME_OPTIONS,
  type JobsRuntimeModuleAsyncOptions,
} from './jobs-runtime-module-options.js';

@Injectable()
class JobsRuntimeHost implements OnModuleInit, BeforeApplicationShutdown {
  // #region Properties
  /** Shared lifecycle and store for the selected capabilities. */
  public readonly runtime: JobsRuntime;
  // #endregion

  // #region Constructor
  /** Builds the shared runtime without opening a database connection. */
  public constructor(@Inject(JOBS_RUNTIME_OPTIONS) options: JobsRuntimeOptions) {
    this.runtime = new JobsRuntime(resolveJobsRuntimeOptions(options), new Logger('JobsRuntime'));
  }
  // #endregion

  // #region Methods
  /** Validates PostgreSQL and starts the selected capabilities before applications use them. */
  public async onModuleInit(): Promise<void> {
    await this.runtime.start();
  }

  /** Stops the selected capabilities before application resources close. */
  public async beforeApplicationShutdown(): Promise<void> {
    await this.runtime.stop();
  }
  // #endregion
}

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

/** Global NestJS module for one explicitly configured jobs process. */
@Module({
  providers: [JobsRuntimeHost, ...capabilityProviders],
  exports: [JobProducer, JobWorkerRegistry, JobScheduler],
})
export class JobsRuntimeModule {
  // #region Methods
  /** Wires runtime capabilities with options available at module declaration. */
  public static forRoot(options: JobsRuntimeOptions): DynamicModule {
    return {
      module: JobsRuntimeModule,
      global: true,
      providers: [{ provide: JOBS_RUNTIME_OPTIONS, useValue: options }],
    };
  }

  /** Wires runtime capabilities through an injected configuration factory. */
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
