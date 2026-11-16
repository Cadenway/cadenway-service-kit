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
export { JobsModule } from './runtime/jobs.module.js';
export { JobsService } from './runtime/jobs.service.js';
export { JobsNotProvisionedError } from './runtime/jobs-not-provisioned.error.js';
export { provisionJobs } from './provisioning/provision-jobs.js';
export type { ProvisionJobsOptions } from './provisioning/provision-jobs.js';
export type { JobQueueDeclaration } from './jobs/job-queue.js';
export type {
  JobsConnectionOptions,
  JobsModuleAsyncOptions,
  JobsModuleOptions,
  RunInOrganization,
} from './jobs/jobs-options.js';
export type {
  Job,
  JobEnqueueOptions,
  JobEnqueueResult,
  JobHandler,
  JobScheduleOptions,
  JobUnscheduleOptions,
  JobWorkOptions,
  JobsQueryResult,
  JobsTransaction,
  JobsTransactionClient,
} from './jobs/job.js';
