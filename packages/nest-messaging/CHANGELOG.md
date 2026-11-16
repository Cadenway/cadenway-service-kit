# @cadenway/nest-messaging

## 0.2.0

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
- Updated dependencies [83af938]
- Updated dependencies [83af938]
  - @cadenway/nest-common@0.5.0

## 0.1.4

### Patch Changes

- a931a52: Separate JetStream subscriptions, delivery and recovery behind the existing `EventConsumers`
  provider, and share the rebuild reply codec between the receiver and emitter.
- Updated dependencies [54356a9]
  - @cadenway/nest-common@0.4.3

## 0.1.3

### Patch Changes

- ce834be: `manageStreams` creates `EVENTS_RESTRICTED` with a maximum age of one hour, as cadenway-ops now does, instead of seven days: its messages carry a single-use code or link. The retention (limits, oldest dropped first), the file storage and the byte cap (`restrictedMaxBytes`, 64 MiB) are unchanged, and so is `EVENTS`. With `manageStreams` on, an existing restricted stream is updated to one hour at the next start; `manageStreams` stays off outside local tests, where cadenway-ops owns the streams.
- Updated dependencies [4cfc7e8]
  - @cadenway/nest-common@0.4.2

## 0.1.2

### Patch Changes

- ad754ff: Redact the payload of a restricted outbox row once it is published. The statement of `OutboxRelay` that marks a row sent now also replaces the payload of a restricted row (stored on the restricted stream, or on a subject under the restricted prefix) with its envelope and a marker, `{ id, occurredAt, organizationId, actor, version, "$redacted": true }`: the single-use code or link of an event such as `one-time-code.issued.v1` no longer stays readable in `outbox_events` until the purge of sent rows. The message published on `restricted.<name>` still carries the full payload, and unrestricted rows keep theirs. A publish that fails, a crash or a failed commit leaves the payload in place for the next attempt. `requeueOutboxEvents` skips a redacted row, and a relay that finds one pending marks it sent again with a warning instead of publishing it. The relay also redacts, at its first pass and with every purge, the restricted rows sent whole before the upgrade or by a replica still on an older kit, so the table converges once the rollout is over.
  
  No schema migration: the `outbox_events` schema is unchanged and `OutboxRelay` keeps its constructor (the messaging options it now reads are optional). Every service keeps working as it is. Once a replica runs this version, run `requeueOutboxEvents` from this version only: an older kit would requeue a redacted row and its relay would publish the bare envelope, which the consumer terminates as an invalid payload. A service whose specs read a code or a link from `outbox_events` after the relay ran (identity-service) reads it from the message in `EVENTS_RESTRICTED` instead. A restricted event lost with NATS is no longer restored by a requeue: its owner issues a new code or link.
- Updated dependencies [ad754ff]
  - @cadenway/nest-common@0.4.1

## 0.1.1

### Patch Changes

- Updated dependencies [00e9d27]
  - @cadenway/nest-common@0.4.0

## 0.1.0

### Minor Changes

- d61aaa1: Implement the NATS JetStream messaging of the kit, in two entry points, aligned with the users, subjects and streams of cadenway-ops.
  
  A service installs the peers `@cadenway/nest-common`, `@nestjs/common`, `@nestjs/core`, `@opentelemetry/api` and `zod`; with the `/outbox` entry point, `drizzle-orm` and `pg` too. `@cadenway/contracts` (`>=0.2.0 <1.0.0`) is an optional peer: the service passes the `eventSchemas` it imports from it.
  
  - `@cadenway/nest-messaging`, usable without a database: `MessagingModule.forRoot`/`forRootAsync` (one connection that waits for its first connect, reconnects forever, uses the inbox prefix `_INBOX.<user>`, and drains on shutdown within `shutdownTimeoutMs`; `manageStreams` off by default, in which case the streams the service uses are checked at start-up), `messagingConfigShape` (`NATS_URL`, `NATS_USER`, `NATS_PASSWORD`), `EventPublisher` (subject derived from the event name, `Nats-Msg-Id`, expected stream, `traceparent`, organization and event-name headers, validation with the schemas of `@cadenway/contracts`), restricted events (`restrictedEvents`: published on `restricted.<name>` in `EVENTS_RESTRICTED`), `EventConsumers.subscribe` (one durable pull consumer `<service>__<handler>` per event with a single filter subject, `AckWait` 30 s, five deliveries, retries after 1 s, 5 s, 30 s and 2 min, a handler deadline with an abort signal, invalid payloads terminated, organization context and consumer span; a consumer deleted on the server is recovered and reported to readiness; consumers are never deleted nor listed), `DeadLetterWorker` (off by default, run by notification-service: advisories of `EVENTS` and `EVENTS_RESTRICTED`, copies on `dlq.<consumer>.<subject>`, restricted bodies dropped by default), `RebuildEmitter.emit({ consumer, entity, schema }, item)` and `EventConsumers.onRebuild` on `rebuild.<consumer user>.<entity>` (plain publish by default, request and reply as an option), `messagingHealthIndicator`.
  - `@cadenway/nest-messaging/outbox`, with `drizzle-orm` and `pg`: the tables `outboxEvents` (with the route of each event), `processedEvents` and `eventVersions` (per organization), `OutboxWriter.append` in the use case transaction, `OutboxRelay` (`for update skip locked`, several replicas, per-row backoff and parking after 20 failures, `wake()`, periodic purge), `purgeSentOutboxEvents`, `purgeProcessedEvents`, `requeueOutboxEvents`, the PostgreSQL deduplicator with `claimVersion`, and `OutboxModule.forRoot`/`forRootAsync`.
  
  Migration for every service that imports `/outbox`: re-export `outboxEvents`, `processedEvents` and `eventVersions` from a `src/modules/*/infrastructure/persistence/*.schema.ts` file, run `drizzle-kit generate`, and add `ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;` and `ALTER TABLE "event_versions" FORCE ROW LEVEL SECURITY;` to the generated migration. A service that imports only the main entry point has nothing to migrate.

### Patch Changes

- Updated dependencies [66cc0c2]
  - @cadenway/nest-common@0.3.0

## 0.0.1

### Patch Changes

- c45eb2b: Declare the third-party dependencies of the kit and add the `@cadenway/nest-jobs` package shell.
  
  - `nest-common`: `nestjs-pino`, `jose`, `cockatiel` and the OpenTelemetry SDK (traces and metrics over OTLP/HTTP); `zod` and `@opentelemetry/api` are peers.
  - `nest-messaging`: the NATS client (`@nats-io/transport-node`, `@nats-io/jetstream`); `drizzle-orm` and `pg` are optional peers, so a gateway without a database can consume events.
  - `nest-testing`: `testcontainers` with its PostgreSQL, NATS and Redis modules, and `msw`.
  - `nest-jobs`: `pg-boss`.
  
  No public API changes: the packages export what they exported before.
