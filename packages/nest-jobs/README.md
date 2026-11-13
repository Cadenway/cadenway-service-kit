# @cadenway/nest-jobs

Durable background jobs for the Cadenway NestJS services.

**Status: package shell.** Nothing is implemented yet and the entry point exports nothing. The
package will hold the jobs a service keeps in its own PostgreSQL database with `pg-boss`: a job
enqueued in the use case transaction, retries with backoff, a dead-letter queue and cron schedules,
as listed in the [repository instructions](../../AGENTS.md).
