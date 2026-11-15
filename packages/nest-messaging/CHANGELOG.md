# @cadenway/nest-messaging

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
