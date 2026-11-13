/**
 * Public entry point of `@cadenway/nest-jobs`.
 *
 * The package will hold the durable background jobs of the services, kept in each service's own
 * PostgreSQL database: a job enqueued in the use case transaction, retries with backoff, a
 * dead-letter queue and cron schedules. Nothing is implemented yet: the entry point exports
 * nothing, so the package builds and packs as a shell.
 *
 * @packageDocumentation
 */
export {};
