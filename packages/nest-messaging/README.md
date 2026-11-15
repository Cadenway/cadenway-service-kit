# @cadenway/nest-messaging

Messaging plumbing for the Cadenway NestJS services and gateways, on NATS JetStream. Implemented
today: the connection, the event publisher, the event consumers with retries, restricted events,
the dead-letter worker, the rebuild channel and the readiness indicator (main entry point); the
outbox table, its writer and relay, and the PostgreSQL deduplicator with version tracking
(`/outbox` entry point).

`@cadenway/contracts`, `@cadenway/nest-common`, `@nestjs/common`, `@nestjs/core`,
`@opentelemetry/api` and `zod` are peer dependencies: the application provides them. `drizzle-orm`
and `pg` are optional peers, needed only by the `/outbox` entry point.

| Entry point                       | Holds                                                                                               | Needs a database |
| --------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------- |
| `@cadenway/nest-messaging`        | `MessagingModule`, `EventPublisher`, `EventConsumers`, `RebuildEmitter`, `DeadLetterWorker`, health | No               |
| `@cadenway/nest-messaging/outbox` | `OutboxModule`, `OutboxWriter`, `OutboxRelay`, `PostgresEventDeduplicator`, the three kit tables    | Yes              |

A gateway imports the main entry point only. A service with a database imports both.

What the broker enforces (users, subjects, streams, who runs the dead-letter worker) is described
in cadenway-ops, `docs/messaging.md`; this package follows it.

## Typing: the event schemas of the contracts

The kit knows no event. Each call takes the `eventSchemas` object of an event module of
`@cadenway/contracts` (`@cadenway/contracts/events/<spec>`): the zod validator of each event, by
name. The event name and the payload type of the call are inferred from it, and the payload is
validated with it on publish and on receipt.

```ts
import { eventSchemas } from '@cadenway/contracts/events/task-service';
```

Every payload carries the envelope the kit reads: `id` (UUID), `occurredAt` (ISO 8601),
`organizationId` (UUID, or `null` for an event outside any organization such as
`user.signed-up.v1`), `actor` (`{ type: 'user' | 'automation' | 'git' | 'system', id }`) and
`version` (the version of the aggregate after the change). A validation error names the fields
that do not match and never echoes the payload.

## Configuration

`messagingConfigShape` validates the variables of the connection. Spread it into the application
schema:

```ts
import { baseConfigShape } from '@cadenway/nest-common';
import { messagingConfigShape } from '@cadenway/nest-messaging';
import { z } from 'zod';

export const appConfigSchema = z.object({ ...baseConfigShape, ...messagingConfigShape });
```

| Variable        | Required | Value                                                                                                                                                            |
| --------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NATS_URL`      | Yes      | One `nats://` or `tls://` URL, or several separated by commas                                                                                                    |
| `NATS_USER`     | No       | NATS user of the service, such as `task`; unset only for an anonymous local broker                                                                               |
| `NATS_PASSWORD` | No       | Password of that user. A secret, mapped by Compose from `<NAME>_NATS_PASSWORD`. Letters and digits starting with a letter: the broker parses it as configuration |

## Messaging module

```ts
import { CONFIG } from '@cadenway/nest-common';
import { MessagingModule } from '@cadenway/nest-messaging';

MessagingModule.forRootAsync({
  inject: [CONFIG],
  useFactory: (config: AppConfig) => ({
    service: 'task-service',
    servers: config.NATS_URL,
    user: config.NATS_USER,
    password: config.NATS_PASSWORD,
  }),
});
```

The module is global. The application waits for its first NATS connection while it starts, then
reconnects forever: a NATS restart suspends publishing and consuming, which resume by themselves.
With a user, the client receives its replies under `_INBOX.<user>`, the only inbox prefix the
broker lets that user subscribe to. Disconnections and reconnections are logged through the
NestJS `Logger`, never a payload. On shutdown (enable the shutdown hooks, as `createApplication`
of `@cadenway/nest-common` does) the consumers stop pulling and their running handlers finish
first, then the connection is drained.

| Option                    | Default                | Effect                                                                                                                                                                                        |
| ------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service`                 | Required               | Name of the service: connection name, prefix of its durable consumers (`<service>__<handler>`). Letters, digits, `-` and `_` only                                                             |
| `servers`                 | Required               | `NATS_URL`: one URL, several separated by commas, or a list                                                                                                                                   |
| `user`, `password`        | None                   | Credentials of the NATS user of the service; the user also sets the inbox prefix                                                                                                              |
| `connectionName`          | `service`              | Name in the server monitoring                                                                                                                                                                 |
| `manageStreams`           | `false`                | Creates or updates the three streams at start-up, for local tests. Off because cadenway-ops owns the streams and no service user may create them; the module then checks the streams it uses  |
| `manageConsumers`         | `true`                 | `subscribe` creates the durable consumer of a handler, or aligns its `AckWait` and delivery limit. With `false` it binds to a consumer created elsewhere and fails clearly when it is missing |
| `deadLetterWorker`        | `false`                | Runs the [dead-letter worker](#dead-letters). notification-service alone turns it on                                                                                                          |
| `restrictedEvents`        | None                   | Names of the [restricted events](#restricted-events), published and consumed in the restricted stream. Only identity-service and notification-service list any                                |
| `eventsStream`            | `EVENTS`               | Stream of the events                                                                                                                                                                          |
| `restrictedStream`        | `EVENTS_RESTRICTED`    | Stream of the restricted events                                                                                                                                                               |
| `deadLetterStream`        | `EVENTS_DLQ`           | Stream of the dead letters                                                                                                                                                                    |
| `eventSubjectPrefix`      | `evt`                  | First token of an event subject                                                                                                                                                               |
| `restrictedSubjectPrefix` | `restricted`           | First token of a restricted event subject                                                                                                                                                     |
| `deadLetterSubjectPrefix` | `dlq`                  | First token of a dead-letter subject                                                                                                                                                          |
| `rebuildSubjectPrefix`    | `rebuild`              | First token of a rebuild subject                                                                                                                                                              |
| `rebuildName`             | `user`, else `service` | Name this application receives rebuilds under: `rebuild.<rebuildName>.<entity>`                                                                                                               |
| `rebuildAcknowledgement`  | `none`                 | How `RebuildEmitter.emit` sends an item: `none` publishes, `reply` waits for the consumer (see [Rebuild](#rebuild))                                                                           |
| `rebuildFlushEvery`       | 100                    | Items published between two flushes in the `none` mode                                                                                                                                        |
| `rebuildTimeoutMs`        | 30 000                 | Time `emit` waits for the consumer in the `reply` mode                                                                                                                                        |
| `eventsMaxBytes`          | 1 GiB                  | Byte cap of `EVENTS`, with `manageStreams`                                                                                                                                                    |
| `restrictedMaxBytes`      | 64 MiB                 | Byte cap of `EVENTS_RESTRICTED`, with `manageStreams`                                                                                                                                         |
| `deadLetterMaxBytes`      | 256 MiB                | Byte cap of `EVENTS_DLQ`, with `manageStreams`                                                                                                                                                |
| `deadLetterMaxAgeDays`    | 30                     | Retention of `EVENTS_DLQ`, with `manageStreams`                                                                                                                                               |
| `publishTimeoutMs`        | 5000                   | Time a publish, or another JetStream request, waits for its answer                                                                                                                            |
| `shutdownTimeoutMs`       | 10 000                 | Time a shutdown waits for running handlers; an abandoned one sees its message redelivered                                                                                                     |
| `retryDelaysMs`           | 1 s, 5 s, 30 s, 2 min  | Delays before each redelivery after a handler failure; their count plus one is the delivery limit. The platform relies on the default: the option exists for tests                            |

Streams, as cadenway-ops creates them and as `manageStreams` creates them locally (file storage,
oldest messages dropped first, duplicates of a `Nats-Msg-Id` refused for two minutes):

| Stream              | Subjects       | Kept                   | Byte cap             |
| ------------------- | -------------- | ---------------------- | -------------------- |
| `EVENTS`            | `evt.>`        | Seven days             | `eventsMaxBytes`     |
| `EVENTS_RESTRICTED` | `restricted.>` | Seven days             | `restrictedMaxBytes` |
| `EVENTS_DLQ`        | `dlq.>`        | `deadLetterMaxAgeDays` | `deadLetterMaxBytes` |

With `manageStreams` off, the application refuses to start when a stream it uses is missing, and
asks only for the stream information its user is given: `EVENTS` always, `EVENTS_RESTRICTED`
when it lists restricted events or runs the dead-letter worker, `EVENTS_DLQ` when it runs the
worker. A stream lost later makes a publish reject with `EventStreamUnavailableError` and
`subscribe` reject with an error naming the stream.

Readiness: `messagingHealthIndicator(connection)` returns a `HealthIndicator` of
`@cadenway/nest-common` (the connection is open and a flush makes the round trip):

```ts
HealthModule.forRootAsync({
  inject: [MessagingConnection],
  useFactory: (connection: MessagingConnection) => ({
    indicators: [messagingHealthIndicator(connection)],
  }),
});
```

## Publishing

Subjects are derived from the event name and never typed: `task.status-changed.v1` is published
on `evt.task.status-changed.v1`. Every message carries `Nats-Msg-Id` (the event id),
`Cadenway-Event-Name`, `Cadenway-Organization-Id` (absent when the organization is `null`) and,
inside a trace, `traceparent` (W3C, from the active OpenTelemetry context).

### With an outbox: a service that changes its own data

The event is appended in the transaction of the use case, so it exists if and only if the use
case commits. PostgreSQL assigns its id (`uuidv7()`) and instant (`now()`).

```ts
import { eventSchemas } from '@cadenway/contracts/events/task-service';
import { OutboxRelay, OutboxWriter } from '@cadenway/nest-messaging/outbox';

await this.tenant.run(async (tx) => {
  await this.tasks.updateStatus(tx, taskId, status);
  await this.outbox.append(tx, eventSchemas, 'task.status-changed.v1', {
    organizationId,
    actor: { type: 'user', id: userId },
    version,
    taskId,
    status,
  });
});
this.relay.wake(); // optional: publish now instead of at the next poll
```

An event that carries an organization is appended in a tenant transaction of that organization
(or a system one). An event without an organization is appended in a system transaction only: the
row-level security policy of the table refuses it in a tenant one, and `append` says so first.

### Without an outbox: a gateway

`EventPublisher.publish(schemas, name, data)` completes the payload with an id (a UUID version 7
generated in process) and the current instant, validates it, publishes it and resolves with the
JetStream acknowledgement (`{ id, stream, streamSequence, duplicate }`). An invalid payload throws
`EventValidationError` before anything is sent. The event is lost if the process dies before the
acknowledgement: use it only where there is no database.

`EventPublisher.publishEnvelope({ name, payload, traceparent })` publishes an already complete
and validated payload with a stored trace context; the relay uses it.

## Restricted events

The identity events that carry a single-use code or link must reach notification-service only.
They live outside `evt.>`: an event listed in `restrictedEvents` is published on
`restricted.<name>`, stored in `EVENTS_RESTRICTED`, and its handlers consume from that stream with
that filter. The subject is derived from the option when the event is published, by
`EventPublisher` and by the outbox relay alike: the outbox row stores only the event name, so
identity-service and notification-service must list the same names. `eventRoute(options, name)`
returns the subject and the stream of an event.

## Consuming

A handler consumes one event through its own durable pull consumer, `<service>__<handler>`, with
the single filter subject of that event. Register it explicitly, from `onApplicationBootstrap` of
a provider:

```ts
import { eventSchemas } from '@cadenway/contracts/events/task-service';
import { EventConsumers } from '@cadenway/nest-messaging';

await this.consumers.subscribe({
  handler: 'index-task',
  schemas: eventSchemas,
  event: 'task.status-changed.v1',
  handle: async (payload, { claimVersion, deliveryCount }) => {
    if (await claimVersion(`task:${payload.taskId}`)) {
      await this.index.upsert(payload);
    }
  },
});
```

| Consumer setting | Value                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Name             | `<service>__<handler>`; renaming a handler creates a new consumer                                                                     |
| Stream, filter   | `EVENTS` and `evt.<event>`, or `EVENTS_RESTRICTED` and `restricted.<event>`: one subject, never a wildcard                            |
| Acknowledgement  | Explicit, `AckWait` 30 s: a handler finishes within 30 seconds or its message is redelivered                                          |
| Deliveries       | Five; no server-side `BackOff`, whose first entry would replace `AckWait`                                                             |
| Start            | `deliverPolicy` of the registration: `all` (default, what the stream still holds) or `new`; only on creation                          |
| Concurrency      | One message at a time per handler and per replica                                                                                     |
| Changes          | Never deleted nor listed by the kit. When the server refuses an update, `subscribe` fails naming the consumer; an operator removes it |

On each delivery the payload is parsed and validated with the schema of the event. A message that
is not JSON or does not match can never succeed: it is terminated (`term`), so it is not
redelivered, becomes a dead letter at once and is logged as an error with the event name, the
consumer and the stream sequence, never the payload. A valid message runs the handler inside the
organization context of the envelope (`runWithOrganizationContext` with its `organizationId` and
`actor`, role `null`, no scopes) and inside an OpenTelemetry consumer span whose parent is the
`traceparent` of the message.

The handler receives the typed payload and `{ deliveryCount, streamSequence, redelivered,
claimVersion }`. Resolving acknowledges the message. Rejecting asks for a redelivery after 1 s,
5 s, 30 s then 2 min (`nak(delay)`), logged as a warning; the fifth failure is logged as an error
and makes the message a dead letter.

**Deduplication.** Without a deduplicator, the handler runs for every delivery, duplicates
included, and `claimVersion` always resolves to `true`: fine for the realtime gateway, which only
relays. Importing `OutboxModule` registers the PostgreSQL deduplicator (`EVENT_DEDUPLICATOR`):
each delivery then runs in one transaction (tenant runner for the organization of the event,
system runner for an event without one) that records `(consumer, event id)` in
`processed_events`, skips the handler when the id is already there, and otherwise runs the
handler in the same transaction: a `run` of the same runner inside the handler joins it. The
message is acknowledged after the commit; a handler failure rolls the processed id back too.
`claimVersion(aggregateKey)` raises the version stored in `event_versions` only when the event is
newer and resolves to whether to apply it: a late redelivery of an older version changes nothing.

`subscribe` and `onRebuild` reject once the application is shutting down.

## Delivery guarantees

- **At least once.** A crash between the publish of an outbox row and its `sent` mark publishes
  the same id again. The server drops a repeated `Nats-Msg-Id` inside its two-minute window only;
  the processed-ids table of the consumer is the real guard.
- **Ordering is not guaranteed**, neither across nor inside a subject (retries reorder). Compare
  versions with `claimVersion`.
- **Exactly-once is not provided.** With the deduplicator, the effects a handler writes through
  the transaction runners are applied once; anything else it does (an e-mail, a call to another
  service) may happen again on a redelivery after a failure.

## Dead letters

JetStream has no dead-letter queue. When a consumer of `EVENTS` or `EVENTS_RESTRICTED` reaches its
delivery limit or terminates a message, the server publishes an advisory on
`$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.<stream>.<consumer>` or
`$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.<stream>.<consumer>`. The worker subscribes to the four
advisory subjects with a queue group (two replicas do not copy twice), reads the original message
by its sequence with `$JS.API.STREAM.MSG.GET.<stream>` (never the direct get API, which the
streams do not enable) and publishes it on `dlq.<consumer>.<original subject>` (`EVENTS_DLQ`) with
its original headers plus:

| Header                                 | Value                                  |
| -------------------------------------- | -------------------------------------- |
| `Cadenway-Dead-Letter-Consumer`        | Durable consumer that gave up          |
| `Cadenway-Dead-Letter-Reason`          | `max-deliveries` or `terminated`       |
| `Cadenway-Dead-Letter-Stream-Sequence` | Sequence of the original in its stream |
| `Cadenway-Dead-Letter-Deliveries`      | Delivery count                         |

Its `Nats-Msg-Id` is `<stream>.<consumer>.<sequence>`, so a repeated advisory stores it once.
Each dead letter is logged as an error, without the payload. No backend consumes `EVENTS_DLQ`;
operators read it.

**Who runs it:** the worker is off by default (`deadLetterWorker: false`) and runs in
notification-service only: reading a message by sequence includes the restricted ones, which no
other backend may see. Advisories are plain NATS messages: one published while no worker is
connected is lost, and its message stays in its stream until it expires.

## Rebuild

An index is rebuilt by its owner re-emitting the current state of its entities on
`rebuild.<consumer>.<entity>`, never by replaying the stream. `<consumer>` is the rebuild name of
the consumer, its NATS user by default (`rebuild.search.task`): the broker lets a user subscribe to
`rebuild.<its user>.>` only. It is plain NATS, outside every stream:

```ts
// In search-service (NATS user `search`): apply re-emitted tasks.
await this.consumers.onRebuild({
  entity: 'task',
  schema: taskItemSchema,
  handle: (item) => this.index.upsert(item),
});

// In task-service: re-emit every task for search-service.
for await (const task of this.tasks.all()) {
  await this.rebuild.emit('search', 'task', taskItemSchema, task);
}
await this.rebuild.flush();
```

Both sides validate the item with the schema the caller passes: an invalid item is not sent
(`RebuildItemError`), and the consumer refuses one that does not match its own schema. Replicas
of the consumer share the items through a queue group, and its handler runs outside any
organization context. Two acknowledgement modes (`rebuildAcknowledgement`):

| Mode             | Behavior                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none` (default) | `emit` publishes the item and flushes every `rebuildFlushEvery` items, which paces the emitter on the server but not on the consumer. **Lossy**: an item sent while no consumer listens, refused, or more than the consumer can buffer is lost. The only mode the permissions of cadenway-ops allow                                            |
| `reply`          | `emit` sends a request and resolves once the consumer applied the item: exact back-pressure when each call is awaited. A refused item rejects with `RebuildRejectedError` (`invalid-item`, `handler-failed`), a missing consumer with `RebuildConsumerUnavailableError`, a slow one with a timeout. The consuming user needs `allow_responses` |

**A rebuild is restartable and not durable:** nothing is stored, an interrupted or lossy rebuild
is simply started again, and applying an item twice must be harmless.

## Outbox module

```ts
import { DatabaseModule } from '@cadenway/nest-common/database';
import { OutboxModule } from '@cadenway/nest-messaging/outbox';

@Module({
  imports: [
    DatabaseModule.forRoot({ connectionString: config.DATABASE_URL }),
    MessagingModule.forRootAsync({/* ... */}),
    OutboxModule.forRoot(),
  ],
})
export class AppModule {}
```

It requires `DatabaseModule` of `@cadenway/nest-common/database` and `MessagingModule`, and
provides `OutboxWriter`, `OutboxRelay` and the deduplicator, globally.

| Option                   | Default | Effect                                                                                                   |
| ------------------------ | ------- | -------------------------------------------------------------------------------------------------------- |
| `relay`                  | `true`  | Runs the relay in this process. Several replicas may run it; turn it off to run it in one replica only   |
| `pollIntervalMs`         | 1000    | Pause between two passes when nothing woke the relay                                                     |
| `batchSize`              | 100     | Rows locked and published per pass                                                                       |
| `purgeIntervalMs`        | 1 hour  | Pause between two purges by the relay; `0` disables them (schedule the purge functions yourself)         |
| `retentionDays`          | 7       | Age of the sent outbox rows the purge deletes                                                            |
| `processedRetentionDays` | 14      | Age of the processed ids the purge deletes: seven days in the stream plus seven days of possible requeue |

**The relay** starts when the application has bootstrapped and stops, after its pass in progress,
on shutdown. Each pass is one transaction of the system runner:
`select ... where status = 'pending' order by attempts, created_at limit <batch> for update skip
locked`, publish each row with `Nats-Msg-Id` set to its id, mark the published ones `sent`. A row
locked by one replica is skipped by the others. A full batch is followed by another pass at once.

A publish failure leaves the row pending, increments `attempts` and stores the class of the error
in `last_error` (never a message or a payload). Rows are read least attempted first, so a row that
keeps failing sinks behind the rows never tried and cannot block them. When the failure means
that NATS or the stream cannot be reached (timeout, closed connection, missing stream), the pass
stops there and the relay backs off, doubling the poll interval up to 30 seconds, instead of
timing out on every row. `relay.publishPending()` runs one pass by hand and returns
`{ published, failed, interrupted }`.

Maintenance functions, each taking the scope of a system transaction:

| Function                                       | Effect                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `purgeSentOutboxEvents(tx, olderThanDays = 7)` | Deletes the rows sent before that age; pending rows are never deleted                    |
| `purgeProcessedEvents(tx, olderThanDays = 14)` | Deletes the processed ids recorded before that age                                       |
| `requeueOutboxEvents(tx, since)`               | Marks pending again the rows sent since `since`, to publish them again after a NATS loss |

## Tables and migrations

| Table              | Columns                                                                                                                                                                                                                                                            | Row-level security          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| `outbox_events`    | `id uuid` primary key (the event id), `event_name`, `organization_id uuid` null, `payload jsonb`, `traceparent` null, `status` (`pending`, `sent`, checked), `attempts`, `last_error` null, `created_at`, `sent_at` null; partial indexes on pending and sent rows | Organization policy, forced |
| `processed_events` | Primary key (`consumer`, `event_id`), `processed_at`, indexed                                                                                                                                                                                                      | None: no organization data  |
| `event_versions`   | Primary key (`consumer`, `aggregate_key`), `version bigint`, `updated_at`                                                                                                                                                                                          | None: no organization data  |

The tables reach a service's own migrations like the idempotency table of nest-common: re-export
them from one of its `src/modules/*/infrastructure/persistence/*.schema.ts` files,

```ts
// src/modules/<module>/infrastructure/persistence/messaging.schema.ts
export { eventVersions, outboxEvents, processedEvents } from '@cadenway/nest-messaging/outbox';
```

then generate the migration (`drizzle-kit generate`) and add by hand, because drizzle-kit does not
generate it:

```sql
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;
```

The application role needs `select, insert, update, delete` on the three tables and no DDL right.
The integration specs create the tables with the DDL drizzle-kit generates from these exports and
run as such a role. A change to these tables ships a migration note for every service.

## NATS subjects the kit uses

The users and their permissions are defined in cadenway-ops (`docs/messaging.md`,
`compose/nats/nats-server.conf`). This is what the kit calls, per feature, so they can be checked
against it. `<user>`, `<service>`, `<handler>`, `<stream>` and `<event>` stand for the values of
the application; the JetStream API prefix is the default `$JS.API`. Every request is answered on
`_INBOX.<user>.>`, which the user subscribes to.

| Feature                                    | Publishes to                                                                                                                                                                 | Subscribes to                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Start-up check (`manageStreams` off)       | `$JS.API.STREAM.INFO.EVENTS`; `.EVENTS_RESTRICTED` with restricted events or the worker; `.EVENTS_DLQ` with the worker                                                       | `_INBOX.<user>.>`                                                                                                      |
| Stream management (`manageStreams`, admin) | `$JS.API.STREAM.INFO.<stream>`, `$JS.API.STREAM.CREATE.<stream>`, `$JS.API.STREAM.UPDATE.<stream>` for the three streams                                                     | `_INBOX.<user>.>`                                                                                                      |
| Publish an event                           | `evt.<event>`, or `restricted.<event>` for a restricted one (a JetStream publish, acknowledged on the inbox)                                                                 | `_INBOX.<user>.>`                                                                                                      |
| Create or update a consumer                | `$JS.API.CONSUMER.INFO.<stream>.<service>__<handler>`, `$JS.API.CONSUMER.CREATE.<stream>.<service>__<handler>.<filter subject>`                                              | `_INBOX.<user>.>`                                                                                                      |
| Consume                                    | `$JS.API.CONSUMER.INFO.<stream>.<service>__<handler>`, `$JS.API.CONSUMER.MSG.NEXT.<stream>.<service>__<handler>`, `$JS.ACK.<stream>.<service>__<handler>.>` (ack, nak, term) | `_INBOX.<user>.>`                                                                                                      |
| Dead-letter worker                         | `$JS.API.STREAM.MSG.GET.EVENTS`, `$JS.API.STREAM.MSG.GET.EVENTS_RESTRICTED`, `dlq.<consumer>.<subject>`                                                                      | `$JS.EVENT.ADVISORY.CONSUMER.{MAX_DELIVERIES,MSG_TERMINATED}.{EVENTS,EVENTS_RESTRICTED}.>` (queue `EVENTS_DLQ-worker`) |
| Emit a rebuild                             | `rebuild.<consumer>.<entity>`                                                                                                                                                | `_INBOX.<user>.>` in the `reply` mode                                                                                  |
| Receive a rebuild                          | The reply subject of a request, in the `reply` mode only (`allow_responses`)                                                                                                 | `rebuild.<rebuildName>.<entity>` (queue `<rebuildName>`)                                                               |
| Readiness                                  | Nothing: a flush is a protocol ping                                                                                                                                          |                                                                                                                        |

The kit never calls `$JS.API.INFO`, `$JS.API.STREAM.NAMES`, `$JS.API.DIRECT.GET`, nor any consumer
delete, list or names API. The integration spec `src/messaging.module.int-spec.ts` runs it against
a server configured like cadenway-ops.

## Limits

- One message at a time per handler and per replica: throughput per handler is bounded by the
  handler latency; scale with replicas.
- A handler must finish within 30 seconds; the kit does not extend `AckWait` with progress
  acknowledgements.
- Dead letters rely on advisories, which are not stored: none is copied while no worker runs.
- A new consumer with the default `deliverPolicy: 'all'` receives what its stream still holds, up
  to seven days of events; a handler with outside effects (notifications) registers with `new`.
- A handler still running after `shutdownTimeoutMs` is abandoned and its message redelivered.
- A rebuild is not durable and, in the default mode, lossy; the stream is not an archive.
- The relay does not reorder events and the consumers do not serialize them.
- The subject of a restricted event is derived when it is published: changing `restrictedEvents`
  while outbox rows are pending moves those rows to the new subject.
