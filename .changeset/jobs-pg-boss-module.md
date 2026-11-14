---
'@cadenway/nest-jobs': minor
---

Implement the durable background jobs on pg-boss, split along the two PostgreSQL roles of a service.

- `provisionJobs({ connection, queues, appRole, schema?, migrationTimeoutMs? })` runs as the migrator role from the one-off migration entry point: it installs or migrates the pg-boss schema, waits for the index builds of a migration, creates or updates the declared queues and their dead-letter queues, and grants the application role data access to the schema. It holds every DDL statement.
- `JobsModule.forRoot(options)` and `JobsModule.forRootAsync(options)` run as the application role and never run DDL. The module is global, uses a pool of two connections apart from the application pool, fails start-up with a `JobsNotProvisionedError` when the schema, a grant or a declared queue is missing, and stops gracefully at shutdown. Options: `connection`, `queues`, `schema` (`pgboss`), `runInOrganization` (calls the handler), `shutdownTimeoutMs` (`30000`).
- `JobsService.enqueue(tx, queue, payload, { occurrenceKey? })` inserts the job through the client of the caller's transaction, so the job exists if and only if the transaction commits. With an occurrence key the job id is derived from the queue and the key, and a second enqueue returns `duplicate: true` while the first job row is retained.
- `JobsService.work(queue, handler, { concurrency?, pollingIntervalSeconds? })` registers a handler that receives `{ id, queue, payload, organizationId, attempt }`. A failed attempt is retried per the queue declaration (5 retries, 30 seconds, exponential backoff by default), then the job moves to the dead-letter queue and an error is logged, without the payload.
- `JobsService.schedule(queue, cron, { timeZone, payload?, key? })` and `unschedule(queue, key?)` manage cron schedules; the IANA time zone is mandatory.
- Queue declarations (`JobQueueDeclaration`) are shared by `provisionJobs` and `JobsModule`; every field but `name` has a documented default.

Services must run `provisionJobs` in their migration container before starting. The entry point exported nothing before, so nothing is removed.
