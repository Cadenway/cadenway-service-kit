# @cadenway/nest-jobs

## 0.4.0

### Minor Changes

- 365bde1: Allow transactional enqueue to set a job's earliest start with the optional `startAfter` date. Occurrence keys also deduplicate delayed jobs.

## 0.3.1

### Patch Changes

- a290617: Respect shutdown grace for durable deliveries and drain active manual outbox passes. Bound dead-letter advisory queues and validate lease prerequisites and runtime timer settings before starting work.
  
  Verify the Jobs database before activating pg-boss and keep nested transactions bound to their original pool and schema. Redact SQL and handler diagnostics and discard unused upstream authentication responses promptly.
  
  Clarify the runtime contracts in the published documentation comments and give production classes
  their own implementation files behind the existing public entry points.

## 0.3.0

### Minor Changes

- 83af938: Separate outbox writing, relay operations and PostgreSQL schema exports. The lease-based relay
  publishes outside its claim and settlement transactions after the owning service has expanded
  its outbox schema. Keep the existing outbox entry point available during the migration.
  Expose PostgreSQL deduplication through a consumer module that is independent of the writer.
  
  Separate Jobs runtime capabilities from provisioning and expose individual producer, worker
  and scheduler APIs. The existing Jobs entry point remains available during the migration.
  
  Separate PostgreSQL transaction execution from its public scope and runners, and expose pool
  wait and transaction duration through OpenTelemetry.

### Patch Changes

- 83af938: Group internal modules and their tests by responsibility while preserving the published entry points.
  
  - Give each PostgreSQL transaction its own Drizzle scope, enforce nested read-only requests, share in-flight readiness probes, bound HTTP error decoding, and separate idempotency storage from HTTP handling.
  - Preserve HTTP failure classification during response body cleanup.
  - Bound rebuild admission, dead-letter shutdown and outbox passes. Recover deleted durable consumers from retained events, prevent overlapping registrations and expired handler starts, and run outbox maintenance separately in coordinated batches.
  - Apply the Jobs grace period to individual attempts, observe visible dead-letter stock outside the startup path, and separate PostgreSQL startup checks and retention diagnostics from the runtime lifecycle.

## 0.2.1

### Patch Changes

- 4d2185e: Separate worker registration, runtime lifecycle and schema provisioning behind the existing jobs API.

## 0.2.0

### Minor Changes

- fcf6aa9: Implement the durable background jobs on pg-boss, split along the two PostgreSQL roles of a service.
  
  - `provisionJobs({ connection, queues, appRole, schema?, migrationTimeoutMs? })` runs as the migrator role from the one-off migration entry point: it installs or migrates the pg-boss schema, waits for the index builds of a migration, creates or updates the declared queues and their dead-letter queues, and grants the application role data access to the schema. It holds every DDL statement. The application role gets no right on the `bam` table, whose statements pg-boss executes as the migrator role, and may only stamp the runtime's interval claims of the `version` table, not the version nor the index-build claim; no default privilege is set. The application role never reaches `bam` during a run either, even with the platform default privileges of cadenway-ops: on a first install the provisioning creates the schema itself and closes it to every other role until the final grants, and on an installed schema it holds the index builds of pg-boss back until `bam` and `version` were checked after the migration, failing closed when a role that can use the schema can write them. A run refuses a stored schema newer than its pg-boss version or older than pg-boss 12.6, and a queue table that holds partitioned rows; two runs started together both succeed. When the application role is the connected role itself, no access is managed.
  - `JobsModule.forRoot(options)` and `JobsModule.forRootAsync(options)` run as the application role and never run DDL. The module is global, uses a pool of two connections apart from the application pool, fails start-up with a `JobsNotProvisionedError` when the schema, a grant or a declared queue is missing, refuses a role that can create objects in the pg-boss schema, and stops gracefully at shutdown. Options: `connection`, `queues`, `schema` (`pgboss`), `runInOrganization` (calls the handler), `shutdownTimeoutMs` (`30000`), `deadLetterCheckIntervalSeconds` (`60`, `0` disables), `allowPrivilegedRole` (`false`).
  - A `connection` without a `connectionString` must name `host`, `user` and `database`, so the role and the database never come from the `PG*` environment variables. The schema cannot be `public` or a system schema.
  - `JobsService.enqueue(tx, queue, payload, { occurrenceKey? })` inserts the job through the client of the caller's transaction, so the job exists if and only if the transaction commits. With an occurrence key the job id is the SHA-256 of `[queue, organizationId, occurrenceKey]` as a version 8 UUID, a stored format that will not change: the key is scoped to the organization of the transaction, and a second enqueue returns `duplicate: true` while the first job row is retained.
  - `JobsService.work(queue, handler, { concurrency?, pollingIntervalSeconds? })` registers the handler of a queue, once per queue and per process. The handler receives `{ id, queue, payload, organizationId, attempt, signal }`; `signal` aborts when the attempt expires or is abandoned at shutdown. A failed attempt is retried per the queue declaration (5 retries, 30 seconds, exponential backoff by default), then the job moves to the dead-letter queue. Only the name and the message of a handler error are stored with the job.
  - Logs never carry a payload. The worker logs an attempt that is rejected, that outlives `expireInSeconds` or that is still running past `shutdownTimeoutMs`: a warning when the job will be retried, an error on the last attempt. Every `deadLetterCheckIntervalSeconds` each replica also logs the count of jobs that arrived in each dead-letter queue, which covers a job whose process crashed.
  - `JobsService.schedule(queue, cron, { timeZone, payload?, key? })` and `unschedule(queue, { key? })` manage cron schedules; the IANA time zone is mandatory. `unschedule` accepts a queue that is no longer declared, and start-up warns about the schedules of such queues.
  - Queue declarations (`JobQueueDeclaration`) are shared by `provisionJobs` and `JobsModule`; every field but `name` has a documented default.
  - `pg-boss` is pinned to the exact version `12.38.2`: the runtime only starts on its exact schema version. A pg-boss bump is a release of the kit with a migration note.
  
  Services must run `provisionJobs` in their migration container before starting. The entry point exported nothing before, so nothing is removed.

## 0.1.0

### Minor Changes

- c45eb2b: Declare the third-party dependencies of the kit and add the `@cadenway/nest-jobs` package shell.
  
  - `nest-common`: `nestjs-pino`, `jose`, `cockatiel` and the OpenTelemetry SDK (traces and metrics over OTLP/HTTP); `zod` and `@opentelemetry/api` are peers.
  - `nest-messaging`: the NATS client (`@nats-io/transport-node`, `@nats-io/jetstream`); `drizzle-orm` and `pg` are optional peers, so a gateway without a database can consume events.
  - `nest-testing`: `testcontainers` with its PostgreSQL, NATS and Redis modules, and `msw`.
  - `nest-jobs`: `pg-boss`.
  
  No public API changes: the packages export what they exported before.
