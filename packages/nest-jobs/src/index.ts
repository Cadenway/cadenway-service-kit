/**
 * Public entry point of `@cadenway/nest-jobs`: the durable background jobs of the Cadenway
 * services, kept in each service's own PostgreSQL database through pg-boss. Everything a consumer
 * may import is listed here by name.
 *
 * `provisionJobs` runs as the migrator role and holds every DDL statement; `JobsModule` and
 * `JobsService` run as the application role and hold none.
 *
 * @packageDocumentation
 */
export { JobsModule } from './jobs.module.js';
export { JobsService } from './jobs.service.js';
export { JobsNotProvisionedError } from './jobs-not-provisioned.error.js';
export { provisionJobs } from './provision-jobs.js';
export type { ProvisionJobsOptions } from './provision-jobs.js';
export type { JobQueueDeclaration } from './job-queue.js';
export type {
  JobsConnectionOptions,
  JobsModuleAsyncOptions,
  JobsModuleOptions,
  RunInOrganization,
} from './jobs-options.js';
export type {
  Job,
  JobEnqueueOptions,
  JobEnqueueResult,
  JobHandler,
  JobScheduleOptions,
  JobWorkOptions,
  JobsQueryResult,
  JobsTransaction,
  JobsTransactionClient,
} from './job.js';
