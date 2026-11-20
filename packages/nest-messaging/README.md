# @cadenway/nest-messaging

Messaging plumbing for the Cadenway NestJS services and gateways, on NATS JetStream. Implemented
today: the connection, the event publisher, the event consumers with retries, restricted events,
the dead-letter worker, the rebuild channel and the readiness indicator (main entry point); the
outbox table, its writer and relay, and the PostgreSQL deduplicator with version tracking
(`/outbox` entry point).

`@cadenway/nest-common`, `@nestjs/common`, `@nestjs/core`, `@opentelemetry/api` and `zod` are
peer dependencies: the application provides them. `drizzle-orm` and `pg` are optional peers
used by the PostgreSQL entry points. `@cadenway/contracts` (`>=0.2.0 <1.0.0`) is an optional
peer: the kit imports nothing from it, the service passes the schemas it imports.

| Entry point                                  | Holds                                                                                               | Needs a database |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------- |
| `@cadenway/nest-messaging`                   | `MessagingModule`, `EventPublisher`, `EventConsumers`, `RebuildEmitter`, `DeadLetterWorker`, health | No               |
| `@cadenway/nest-messaging/consumer/postgres` | `PostgresEventDeduplicationModule`, `PostgresEventDeduplicator`                                     | Yes              |
| `@cadenway/nest-messaging/outbox`            | `OutboxModule`, `OutboxWriter`, `OutboxRelay`, `PostgresEventDeduplicator`, the three kit tables    | Yes              |

A gateway without PostgreSQL imports the main entry point. Services compose the PostgreSQL
entry points for the capabilities used in each process.

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

`forRootAsync` also takes `imports`, for a factory that injects providers of a module that is not
global.

The module is global. The application waits for its first NATS connection while it starts, then
reconnects forever: a NATS restart suspends publishing and consuming, which resume by themselves.
With a user, the client receives its replies under `_INBOX.<user>`, the only inbox prefix the
broker lets that user subscribe to. Disconnections and reconnections are logged through the
NestJS `Logger`, never a payload. On shutdown (enable the shutdown hooks, as `createApplication`
of `@cadenway/nest-common` does) the consumers stop taking new deliveries. Running handlers have
up to `shutdownTimeoutMs` to finish before the connection is drained. A drain that does not finish within `shutdownTimeoutMs`,
as when the server is gone, gives way to a plain close.

**`service` names every durable consumer.** Changing it renames them all: the new consumers
start from scratch, the processed ids and versions recorded under the old names no longer apply,
and with `deliverPolicy: 'all'` up to seven days of events are delivered again.

| Option                        | Default                | Effect                                                                                                                                                                                        |
| ----------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service`                     | Required               | Name of the service: connection name, prefix of its durable consumers (`<service>__<handler>`). Letters, digits, `-` and `_` only                                                             |
| `servers`                     | Required               | `NATS_URL`: one URL, several separated by commas, or a list                                                                                                                                   |
| `user`, `password`            | None                   | Credentials of the NATS user of the service; the user also sets the inbox prefix                                                                                                              |
| `connectionName`              | `service`              | Name in the server monitoring                                                                                                                                                                 |
| `manageStreams`               | `false`                | Creates or updates the three streams at start-up, for local tests. Off because cadenway-ops owns the streams and no service user may create them; the module then checks the streams it uses  |
| `manageConsumers`             | `true`                 | `subscribe` creates the durable consumer of a handler, or aligns its `AckWait` and delivery limit. With `false` it binds to a consumer created elsewhere and fails clearly when it is missing |
| `deadLetterWorker`            | `false`                | Runs the [dead-letter worker](#dead-letters). notification-service alone turns it on                                                                                                          |
| `restrictedEvents`            | None                   | Names of the [restricted events](#restricted-events), published and consumed in the restricted stream. Only identity-service and notification-service list any                                |
| `eventsStream`                | `EVENTS`               | Stream of the events                                                                                                                                                                          |
| `restrictedStream`            | `EVENTS_RESTRICTED`    | Stream of the restricted events                                                                                                                                                               |
| `deadLetterStream`            | `EVENTS_DLQ`           | Stream of the dead letters                                                                                                                                                                    |
| `restrictedDeadLetterPayload` | `drop`                 | Body of the dead-letter copy of a restricted event: `drop` keeps the headers only, as the body may hold a single-use code; `copy` keeps it                                                    |
| `eventSubjectPrefix`          | `evt`                  | First token of an event subject. The four prefixes are single tokens and pairwise distinct                                                                                                    |
| `restrictedSubjectPrefix`     | `restricted`           | First token of a restricted event subject                                                                                                                                                     |
| `deadLetterSubjectPrefix`     | `dlq`                  | First token of a dead-letter subject                                                                                                                                                          |
| `rebuildSubjectPrefix`        | `rebuild`              | First token of a rebuild subject                                                                                                                                                              |
| `rebuildName`                 | `user`, else `service` | Name this application receives rebuilds under: `rebuild.<rebuildName>.<entity>`                                                                                                               |
| `rebuildAcknowledgement`      | `none`                 | How `RebuildEmitter.emit` sends an item: `none` publishes, `reply` waits for the consumer (see [Rebuild](#rebuild))                                                                           |
| `rebuildFlushEvery`           | 100                    | Items published between two flushes in the `none` mode                                                                                                                                        |
| `rebuildMaxPending`           | 1000                   | Maximum number of waiting items per rebuild subscription. The consumer also caps the combined size of waiting payloads and reply subjects at 16 MiB.                                          |
| `rebuildTimeoutMs`            | 30 000                 | Time `emit` waits for the consumer in the `reply` mode, and a flush waits for the server in the `none` mode                                                                                   |
| `handlerTimeoutMs`            | 25 000                 | Time a handler may take, below the 30 s `AckWait`. Past it the attempt is abandoned and retried (see [Consuming](#consuming))                                                                 |
| `eventsMaxBytes`              | 1 GiB                  | Byte cap of `EVENTS`, with `manageStreams`                                                                                                                                                    |
| `restrictedMaxBytes`          | 64 MiB                 | Byte cap of `EVENTS_RESTRICTED`, with `manageStreams`                                                                                                                                         |
| `deadLetterMaxBytes`          | 256 MiB                | Byte cap of `EVENTS_DLQ`, with `manageStreams`                                                                                                                                                |
| `deadLetterMaxAgeDays`        | 30                     | Retention of `EVENTS_DLQ`, with `manageStreams`                                                                                                                                               |
| `publishTimeoutMs`            | 5000                   | Time a publish, or another JetStream request, waits for its answer                                                                                                                            |
| `shutdownTimeoutMs`           | 10 000                 | Time a shutdown waits for running handlers, then for the drain of the connection; an abandoned handler sees its message redelivered                                                           |

The publish, rebuild and shutdown timeouts accept whole milliseconds from 1 to 2,147,483,647.
The default retry delays (1 s, 5 s, 30 s, 2 min, so five deliveries) are not a module option. A
handler that needs another schedule sets its own `redelivery` when it subscribes (see
[Redelivery schedule](#redelivery-schedule)); every other durable consumer gets the default
`max_deliver`. The specs of the package shorten the default delays through an internal provider.

Streams, as cadenway-ops creates them and as `manageStreams` creates them locally (file storage,
oldest messages dropped first, duplicates of a `Nats-Msg-Id` refused for two minutes):

| Stream              | Subjects       | Kept                   | Byte cap             |
| ------------------- | -------------- | ---------------------- | -------------------- |
| `EVENTS`            | `evt.>`        | Seven days             | `eventsMaxBytes`     |
| `EVENTS_RESTRICTED` | `restricted.>` | One hour               | `restrictedMaxBytes` |
| `EVENTS_DLQ`        | `dlq.>`        | `deadLetterMaxAgeDays` | `deadLetterMaxBytes` |

With `manageStreams` off, the application refuses to start when a stream it uses is missing, and
asks only for the stream information its user is given: `EVENTS` always, `EVENTS_RESTRICTED`
when it lists restricted events or runs the dead-letter worker, `EVENTS_DLQ` when it runs the
worker. A stream lost later makes a publish reject with `EventStreamUnavailableError` and
`subscribe` reject with an error naming the stream.

Readiness: `messagingHealthIndicator(connection, name = 'nats')` returns a `HealthIndicator` of
`@cadenway/nest-common`, reported under `name` in the readiness body. It is up while the
connection is open, every durable consumer of the application works (none missing, being
recovered or stopped), and a flush makes the round trip:

```ts
HealthModule.forRootAsync({
  inject: [MessagingConnection],
  useFactory: (connection: MessagingConnection) => ({
    indicators: [messagingHealthIndicator(connection)],
  }),
});
```

`MessagingConnection` exposes `isClosed()` and `flush()` only: the NATS clients it holds are
internal and absent from the published declarations.

## Publishing

Subjects are derived from the event name and never typed: `task.status-changed.v1` is published
on `evt.task.status-changed.v1`. Every message carries `Nats-Msg-Id` (the event id),
`Cadenway-Event-Name`, `Cadenway-Organization-Id` (absent when the organization is `null`) and,
inside a trace, `traceparent` (W3C, from the active OpenTelemetry context). Every publish names
the stream that must store it (`Nats-Expected-Stream`): a subject captured by another stream is
refused instead of stored elsewhere.

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
`EventValidationError` before anything is sent. A publish that times out or finds no stream is
tried three times with the same `Nats-Msg-Id`. The event is lost if the process dies before the
acknowledgement: use it only where there is no database.

`EventPublisher.publishEnvelope({ name, subject, stream, payload, traceparent })` publishes an
already complete and validated payload on the route it carries, once; the relay uses it. To
retry it, call it again with the same event: the id is kept and the server keeps one copy.

## Restricted events

The identity events that carry a single-use code or link must reach notification-service only.
They live outside `evt.>`: an event listed in `restrictedEvents` is published on
`restricted.<name>`, stored in `EVENTS_RESTRICTED`, and its handlers consume from that stream with
that filter. `EventPublisher.publish` routes with its own options. `OutboxWriter.append` routes
when the use case writes the event and stores the subject and the stream in the outbox row; the
relay publishes that route as it is. During a rolling deploy, a replica that does not list the
event yet cannot move it to `evt.>`.

**The outbox does not keep the code.** The statement that marks a restricted row sent (a row
stored on `EVENTS_RESTRICTED`, or on a subject under `restricted.`) replaces its payload with its
envelope and a marker, `{ id, occurredAt, organizationId, actor, version, "$redacted": true }`,
so the single-use code or link it carried does not stay in the table while a sent row is kept
(`retentionDays`, seven by default). The message on `restricted.<name>` carries the full payload.
Unrestricted rows keep theirs. The column keeps its type and its constraints: the table schema
does not change.

- A publish that fails leaves the payload in place for the next attempt, and so does a crash or a
  failed commit after the publish: the row stays pending and whole, and is redacted only by the
  statement that marks it sent. A row parked after 20 failures keeps its payload until it is
  requeued and published.
- Rows sent whole before the upgrade, or by a replica still on an older kit during the rollout,
  are redacted by the relay at startup and with every purge (`purgeIntervalMs`), so the table
  converges once every replica runs this version. The initial sweep also runs with periodic
  purges disabled. A failed maintenance transaction stays due and retries after the poll interval
  independently of the publication backoff.
- A redacted row is never published again by this version. `requeueOutboxEvents` skips it, and a
  relay that finds one pending (set pending by hand, or by the requeue of an older kit) marks it
  sent again with a warning instead of publishing it. A relay of an older kit would publish its
  bare envelope, which the consumer terminates as an invalid payload: once a replica runs this
  version, run `requeueOutboxEvents` from this version only. A restricted event lost with NATS is
  not restored by a requeue: its owner issues a new code or link.
- A spec that needs the code reads the message from `EVENTS_RESTRICTED`, as notification-service
  receives it, not the outbox row.

## Consuming

`EventConsumers` owns the Nest lifecycle and shares a shutdown signal across the durable
subscriptions and rebuild receivers. Internally, `consumer/subscriptions/` registers and opens the
durables, `consumer/recovery/` maintains their pull loops, and `consumer/delivery/` handles one
message at a time. The rebuild receiver and emitter use the same reply codec in `rebuild/`.

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

| Consumer setting | Value                                                                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name             | `<service>__<handler>`; renaming a handler creates a new consumer                                                                                                                   |
| Stream, filter   | `EVENTS` and `evt.<event>`, or `EVENTS_RESTRICTED` and `restricted.<event>`: one subject, never a wildcard                                                                          |
| Acknowledgement  | Explicit, `AckWait` 30 s: a handler finishes within 30 seconds or its message is redelivered                                                                                        |
| Deliveries       | Five, or the `redelivery.maxDeliveries` of the registration; no server-side `BackOff`, whose first entry would replace `AckWait`                                                    |
| Start            | `deliverPolicy` of the registration: `all` (default, what the stream still holds) or `new`; only on creation                                                                        |
| Concurrency      | One message at a time per handler and per replica                                                                                                                                   |
| Changes          | `AckWait` and `max_deliver` updated in place. Never deleted nor listed by the kit. When the server refuses an update, `subscribe` fails naming the consumer; an operator removes it |
| Loss             | A consumer deleted on the server, or lost with its stream, is reported down to readiness and recovered: see below                                                                   |

**A consumer that disappears.** The client reports it (`consumer_deleted`, `consumer_not_found`, `no_responders`,
`stream_not_found`); the kit closes the pull loop, reports the consumer to readiness and recovers
it, trying again after 0 s, 1 s, 2 s, 5 s, 10 s then every 30 s. With `manageConsumers` it creates
the consumer again from the beginning of the retained stream, including for registrations that
start with `deliverPolicy: 'new'`. Deleting a shared durable removes the broker's delivery position
and pending acknowledgements. Starting at the beginning includes events that need redelivery on
other replicas. Replay can deliver retained events again. The transactional deduplicator skips
already recorded deliveries when it is configured. Without `manageConsumers` the kit waits for
the platform to create the consumer again. A fresh process that finds no durable uses the
registration's start policy. It has no prior subscription state to distinguish a deletion from
a first deployment.

On each delivery the payload is parsed and validated with the schema of the event. A message that
is not JSON or does not match can never succeed: it is terminated (`term`), so it is not
redelivered, becomes a dead letter at once and is logged as an error with the event name, the
consumer and the stream sequence, never the payload. A valid message runs the handler inside the
organization context of the envelope (`runWithOrganizationContext` with its `organizationId` and
`actor`, role `null`, no scopes) and inside an OpenTelemetry consumer span whose parent is the
`traceparent` of the message. A failed attempt sets the span status to error with the class of
the error only (`error.type`), never its message, which may quote a payload.

**Actor kinds.** The envelope types `actor.type` as a string, so a minor of `@cadenway/contracts`
that adds a kind of actor does not break the compilation of a service. The organization context
knows `user`, `automation`, `git` and `system`; an event with another kind runs its handler as
`{ type: 'system', id: null }`, with one warning per consumer and kind. Upgrade the kit when the
contracts add an actor kind.

The handler receives the typed payload and `{ deliveryCount, streamSequence, redelivered,
claimVersion, signal }`. Resolving allows the delivery to be acknowledged. Rejecting asks for a redelivery after
1 s, 5 s, 30 s then 2 min (`nak(delay)`), or after the delays of the handler's own
[redelivery schedule](#redelivery-schedule), logged as a warning; the failure of the last allowed
delivery (the fifth by default) is logged as an error and makes the message a dead letter. A handler still running after `handlerTimeoutMs`
(25 s) is abandoned: `signal` is aborted (pass it to the calls the handler makes), the attempt
counts as failed and the next message is handled. An answer that cannot be sent because the
connection closed is logged at debug level; the server redelivers the message. If shutdown
grace expires, `signal` is aborted and the delivery is left unacknowledged for JetStream to
redeliver. Failure logs carry delivery metadata and an error category.

**Deduplication.** Without a deduplicator, the handler runs for every delivery, duplicates
included, and `claimVersion` always resolves to `true`: fine for the realtime gateway, which only
relays. Import `PostgresEventDeduplicationModule` from `@cadenway/nest-messaging/consumer/postgres`
alongside `MessagingModule` and `DatabaseModule` to register durable deduplication. The service
migrations provide the `processed_events` and `event_versions` tables. The legacy `OutboxModule`
registers the same deduplicator. It opens a transaction per delivery and must be called outside
any active transaction (tenant runner for the organization of the event, system runner for an event
without one) that records `(consumer, event id)` in `processed_events`, skips the handler when
the id is already there, and otherwise runs the handler in the same transaction: a `run` of the
same runner inside the handler joins it. The message is acknowledged after the commit. A handler
that fails or is abandoned before commit rolls back the processed id and its writes. The database
transaction runs once per delivery so the consumer's JetStream policy controls handler retries. When
shutdown leaves a committed delivery unacknowledged, a redelivery skips the handler. No statement of that transaction may
run longer than `handlerTimeoutMs`, and the claim of the processed id waits at most five seconds
(`lock_timeout`) for another delivery of the same event: past it the delivery fails and is retried
after the next delay, when it finds the id and skips the handler.
`claimVersion(aggregateKey)` raises the version stored in `event_versions` for the organization of
the event only when the event is newer, and resolves to whether to apply it: a late redelivery of
an older version changes nothing, and two organizations never compete for the same key.

Set `transactionIsolationLevel: 'repeatable read'` on a subscription that needs one PostgreSQL
snapshot for several reads and transactional writes. The setting applies to the entire delivery,
including the deduplication claim and any outbox writes. It requires PostgreSQL event
deduplication. Registration fails before creating or binding a consumer without it. Omitting
the setting uses the database's default isolation. A nested call to the matching runner can
join the transaction with the same isolation level. A serialization failure rolls back the
delivery transaction and is retried through the configured JetStream redelivery schedule.

`subscribe` and `onRebuild` reject once the application is shutting down.

### Catch-up before serving traffic

`MessagingConnection.watchAvailability(listener)` calls a synchronous listener with the current
combined transport and durable health, then with each transition. A detected broker disconnect,
an unhealthy local durable or shutdown reports `false`. Reconnection or durable recovery can
restore availability once transport and local consumers are healthy. The returned function removes
the listener. A listener throwing or returning a rejected promise does not interrupt other watches.
During application shutdown availability closes before waiting for running handlers. This watch is
opt-in and leaves normal delivery unchanged.

`EventConsumers.areCaughtUp(handlerNames, signal?)` reads the broker's pending-delivery and
unacknowledged counts, using the same exact consumer info permissions as subscription registration.
Pass one to 32 registered local handler names, without service prefixes. The check returns
`false` if a count is nonzero, a handler is unknown or stopped, availability was interrupted,
the broker read failed or the optional signal was aborted. Build any startup or reconnect gate
by closing it on an unavailable transition and performing a fresh, nonoverlapping check in the
next available interval. Cancellation stops waiting. Requests already sent remain bounded by
the configured JetStream timeout. Catch-up only samples current broker state and can change
when a new message arrives. It does not confirm the effects of expired, terminated or
dead-lettered messages.

`EventConsumers.readProgress(handlerNames, signal?)` samples one to 32 locally running handlers
on the configured ordinary event stream. It reads the stream high watermark before sampling
the durables, then reads the stream retention floor and verifies the stream identity and gap
count again. The response has `stream`, `createdAt`, `firstSequence`, `lastSequence`,
`retainedGapCount`, and `consumers`. The consumer entries have the local `handler` name,
durable `createdAt`, `deliveredSequence`, `ackFloorSequence`, `pending` and `ackPending`.
Sequences use stream coordinates. Keep the timestamp strings at full precision when comparing
observations across a rebuild.

The probe reads the exact stream and consumer info subjects. It returns `undefined` for an
unknown, restricted or stopped handler, cancellation, interrupted delivery availability,
malformed metadata, an unsuccessful broker read, or a recreated stream during sampling.
Cancellation stops waiting and requests already sent use the configured JetStream timeout.
Only an explicit call performs these reads. The response is a bounded observation of a moving
broker, with consumer counts that may include events above the sampled `lastSequence`. A
filtered consumer's acknowledgement floor may stay below the stream head even when it has no
backlog. Compare the retention bounds and `retainedGapCount` across rebuild observations. A
positive count indicates holes in the retained range. Equal counts can describe different
holes. Check for missing history and terminal deliveries before promotion, and coordinate
consumer resets or stream administration with the rebuild.

### Terminal consumer advisory guard

`MessagingConnection.isConsumerAdvisoryStreamClear(advisoryStream, eventStream, durables, signal?)`
checks a persistent operational stream provisioned by the broker operator. Pass trusted
configuration for a single event stream and one to 32 distinct **full** durable names
(`<service>__<handler>`). Names must contain only letters, digits, underscores or hyphens and
may have at most 128 characters. The probe reads only metadata through the exact
`$JS.API.STREAM.INFO.<advisoryStream>` permission. It does not read the advisory bodies or
create, consume or purge the stream.

The stream must capture both native `MAX_DELIVERIES` and `MSG_TERMINATED` subjects for each
configured durable, using the exact stream and durable tokens with no wildcards. It uses file
storage, limits retention and discard-old with one retained message, no age limit and no byte,
per-message size or per-subject limit. Disable per-message TTL, rollups and scheduled messages.
The stream must accept new advisories directly without mirrors, sources, subject transforms or
republishing. Keep `deny_delete` disabled so an operator can rearm the guard. After reconciling
the failure, the operator deletes only the inspected advisory's stream sequence. A newer advisory
that replaced it during reconciliation keeps the guard closed. Provision the stream before the
protected consumers start.

The probe returns `false` when there is an advisory, the stream is missing or its configuration
does not match, or the check is invalid, interrupted or unsuccessful. Cancellation stops waiting.
Issued requests remain subject to the JetStream timeout. Pair this probe with the availability
watch and catch-up check, and refresh the probe while serving traffic. This is a snapshot of
advisories already stored. The probe cannot detect an event evicted before JetStream emits an
advisory or a failure that happened before the operational stream was provisioned.

### Redelivery schedule

A handler whose effects must not be given up after a few minutes, such as a security projection
(memberships, a directory) that a failure would leave granting too much, sets its own schedule:

```ts
await this.consumers.subscribe({
  handler: 'project-membership',
  schemas: eventSchemas,
  event: 'member.removed.v1',
  // 1 s, 5 s, 30 s, 2 min, 10 min, 30 min, then every hour; 32 deliveries.
  redelivery: {
    delaysMs: [1_000, 5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000],
    maxDeliveries: 32,
  },
  handle: async (payload, { claimVersion }) => {
    // ...
  },
});
```

The 31 failed deliveries wait 1 s + 5 s + 30 s + 2 min + 10 min + 30 min, then 25 times one hour:
92,556 s, about 25 h 43 min, before the dead letter. The margin over 24 hours covers a delivery
lost to a crashed replica, which the server redelivers after the 30 s `AckWait` instead of the
scheduled delay and which counts as a delivery.

| `redelivery` member | Default                  | Effect                                                                                                                     |
| ------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `delaysMs`          | Required                 | Delay before each redelivery, in milliseconds: the first failure waits the first delay. The last delay repeats when needed |
| `maxDeliveries`     | One more than the delays | Deliveries, the first included, before the dead letter: the `max_deliver` of the durable consumer                          |

Without `redelivery`, a handler keeps the default schedule (1 s, 5 s, 30 s, 2 min, five
deliveries). The schedule is applied by the kit with `nak(delay)`: the consumer keeps its 30 s
`AckWait` and gets no server-side `BackOff`, whose first entry would replace `AckWait`. A handler
timeout still counts as a failure and waits the scheduled delay.

**Checked at start-up.** `subscribe` checks the schedule before any broker request and rejects,
so the application does not start, when:

- a delay is not a whole number of milliseconds from 1;
- `maxDeliveries` is not a whole number above the number of delays: JetStream requires
  `max_deliver` to exceed the length of a `BackOff` list, and the kit holds its own list to the
  same rule, since a delay past the limit is never used. An empty list allows one delivery only;
- the whole schedule, from the first delivery, every delay plus one 30 s `AckWait` per delivery,
  does not end within half of the time the stream keeps a message: 3.5 days for `EVENTS`
  (seven days kept), 30 minutes for `EVENTS_RESTRICTED` (one hour kept), from the constants of
  the kit, which mirror cadenway-ops. The other half covers what the schedule does not count: the
  time before the first delivery, outages without a replica pulling and the copy of the dead
  letter. A message the stream drops while it waits for a redelivery is lost without a dead
  letter.

**Existing consumers.** With `manageConsumers` (the default), `subscribe` updates the
`max_deliver` (and `AckWait`) of an existing durable consumer in place, logged as
`durable consumer updated in place` with the previous and new values: the consumer keeps its name, its position and its pending
messages. A pending message waits the delay it was already given, then goes on with the new
schedule from its delivery count, so a
message on its third delivery under the default schedule gets 29 more deliveries under the one
above. A message that already became a dead letter under the old limit is not delivered again.
Lowering the limit below the delivery count of a pending message makes it a dead letter without
delivering it again (`Cadenway-Dead-Letter-Deliveries` is its count so far). Removing
`redelivery` brings the consumer back to five deliveries the same way. With `manageConsumers` off,
the kit cannot change the consumer: a registration with its own `redelivery` refuses to start
unless the consumer created elsewhere already has `max_deliver` equal to its `maxDeliveries`; one
without `redelivery` binds as before, whatever the limit.

**Limits of a long schedule.**

- Roll a schedule out with a deployment that replaces every replica before relying on it. A
  replica still on the previous limit treats its own last delivery as final and asks for an
  immediate redelivery, so the remaining deliveries can be used up in seconds (the message still
  ends as a dead letter), and such a replica that restarts sets `max_deliver` back to its limit.
- The byte cap of the stream (`EVENTS` 1 GiB as cadenway-ops sizes it) drops the oldest messages
  first and is not checked: a message waiting on a long schedule is among the oldest, and a
  platform that writes more than the cap during the schedule drops it without a dead letter.
- A message waiting for its redelivery stays unacknowledged and counts towards the
  `max_ack_pending` of the consumer (1000, the server default, which the kit does not change):
  when that many messages wait on long delays, the handler receives no new message until one of
  them is delivered again.
- A dead letter is only copied while the [dead-letter worker](#dead-letters) runs.

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
| `Cadenway-Dead-Letter-Payload`         | `dropped` when the body was not copied |

The copy of a restricted event keeps its headers and has an empty body, because the body may
hold a single-use code that would otherwise sit 30 days in `EVENTS_DLQ`; set
`restrictedDeadLetterPayload: 'copy'` to keep it. Its `Nats-Msg-Id` is
`<stream>.<consumer>.<sequence>`, so a repeated advisory stores it once, and the publish requires
`EVENTS_DLQ` to store it. A copy that fails (the dead-letter stream briefly missing, a timeout) is
tried five times over about two minutes, then logged as an error naming the consumer, the stream
and the sequence. Each dead letter is logged as an error, without the payload; a termination
reason other than the kit's own is logged as `external-termination`. No backend consumes
`EVENTS_DLQ`; operators read it. Each advisory subscription copies one message at a time and
queues up to 1,000 advisories or 16 MiB in arrival order, whichever limit is reached first.
Once full it drops new arrivals and periodically reports the number dropped. At shutdown the worker unsubscribes, stops retries, and gives
in-flight copies up to `shutdownTimeoutMs` to finish. Advisories still waiting are dropped.
The connection then drains in its own shutdown phase.

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
const target = { consumer: 'search', entity: 'task', schema: taskItemSchema };
for await (const task of this.tasks.all()) {
  await this.rebuild.emit(target, task);
}
await this.rebuild.flush();
```

Both sides validate the item with the schema the caller passes: an invalid item is not sent
(`RebuildItemError`), and the consumer refuses one that does not match its own schema. Replicas
of the consumer share the items through a queue group, and its handler always runs in a context
without organization, whatever the context `onRebuild` was called in. Each subscription admits
at most `rebuildMaxPending` waiting items (1000 by default) and 16 MiB of waiting payload and
reply-subject data. These limits exclude the item being handled. Admission evicts the oldest
waiting items as needed. An item that exceeds the byte limit by itself is rejected without
evicting any waiting items. The consumer logs overload and replies with `overloaded` when a
reply subject is available. Two acknowledgement modes (`rebuildAcknowledgement`):

| Mode             | Behavior                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none` (default) | `emit` publishes the item and flushes every `rebuildFlushEvery` items, which paces the emitter on the server but not on the consumer: a flush not confirmed within `rebuildTimeoutMs`, as during an outage, rejects with `RebuildFlushTimeoutError`. **Lossy**: a refused or evicted item, or an item sent while no consumer listens, is lost. This is the mode supported by the permissions of cadenway-ops   |
| `reply`          | `emit` sends a request and resolves once the consumer applied the item: exact back-pressure when each call is awaited. A refused item rejects with `RebuildRejectedError` (`invalid-item`, `handler-failed`, `overloaded`, or `unknown` for a reason a newer consumer sends), a missing consumer with `RebuildConsumerUnavailableError`, a slow one with a timeout. The consuming user needs `allow_responses` |

**A rebuild is restartable and not durable:** nothing is stored, an interrupted or lossy rebuild
is simply started again, and applying an item twice must be harmless.

## Outbox module

`@cadenway/nest-messaging/outbox` is a deprecated compatibility entry point. It keeps the original
schema type and relay behavior during migration. New deployments can compose independent entry
points:

| Entry point      | Responsibility                                  |
| ---------------- | ----------------------------------------------- |
| `/outbox/writer` | `OutboxWriterModule`, transactional writes      |
| `/outbox/relay`  | `OutboxRelayModule`, publication and retention  |
| `/outbox/schema` | Drizzle tables and lease migration finalization |

Import `OutboxWriterModule.forRoot()` in a process that appends events. It registers no publication
loop. Add `PostgresEventDeduplicationModule` explicitly to every consuming process that relied on
the legacy deduplicator before removing `OutboxModule`. An independent relay process imports its
own `DatabaseModule` with the application role,
`MessagingModule` and `OutboxRelayModule.forRoot()`. It does not need `OutboxWriterModule`.
An existing process can load both new modules to keep a combined deployment. Use
`OutboxRelayModule.forRootAsync()` when relay options come from an injected configuration.

The leased relay reserves up to `concurrency` rows (four by default) in a short PostgreSQL
transaction, publishes the batch concurrently and commits outcomes in a second transaction.
Each lease lasts at least 30 seconds and at least twice `publishTimeoutMs`. Set `leaseMs` to
increase that floor. Lease checks use PostgreSQL time. A late settlement can never change a
replacement lease. The same event id is used after a crash, including a crash after a broker ACK
and before settlement. Consumers still need durable deduplication. Restricted rows are redacted
in the same update that marks them sent.

The relay polls every `pollIntervalMs` (1000 by default) when the queue is empty, applies broker
backoff and runs retention independently. On shutdown it stops claiming and gives the current
batch up to `shutdownTimeoutMs` (10 seconds by default) to settle. Unsettled rows become
reclaimable at expiry. Set `autoStart: false` for manual operation with
`LeasedOutboxRelay.publishPending()`. Manual calls must begin outside any active transaction.
The relay emits `cadenway.outbox.lease.*` metrics for claim and settlement durations, queue age,
publication duration and attempt outcomes.

**Service-owned migration.** Generate an additive migration by switching the service's schema
re-export to `/outbox/schema`. Add nullable `lease_token` and `lease_expires_at`, allow `leased`
in the status check and add the lease-state check. The new partial index covers
`(lease_expires_at, id) WHERE status = 'leased'`. Install and validate both checks and the
partial index before enabling the leased relay. The migration finalizer rejects a valid index
that uses the expected name but has a different definition. The legacy writer still inserts `pending` and the legacy relay still
claims only `pending`. Keep the migration applied when reverting.

**Rollback.** Stop the leased relay and allow in-flight reservations to expire. Run
`recoverExpiredOutboxLeases(tx)` in bounded system transactions to make expired rows pending
again. Inspect the count of `leased` rows before restoring the legacy relay, including leases
that may still be unexpired or locked. Resume legacy publication only once the count is zero.

### Legacy wiring

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
provides `OutboxWriter`, `OutboxRelay` and the deduplicator, globally. `OutboxModule.forRootAsync({
imports, inject, useFactory })` builds the options from injected providers.

| Option                   | Default | Effect                                                                                                                           |
| ------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `relay`                  | `true`  | Runs the relay in this process. Several replicas may run it; turn it off to run it in one replica only                           |
| `pollIntervalMs`         | 1000    | Pause between two passes when nothing woke the relay                                                                             |
| `batchSize`              | 100     | Rows locked and published per pass                                                                                               |
| `purgeIntervalMs`        | 1 hour  | Pause between automatic maintenance sweeps, each of which also redacts restricted rows sent whole. `0` disables periodic sweeps. |
| `retentionDays`          | 7       | Age of the sent outbox rows the purge deletes                                                                                    |
| `processedRetentionDays` | 14      | Age of the processed ids the purge deletes: seven days in the stream plus seven days of possible requeue                         |

**The relay** starts when the application has bootstrapped and stops, after its pass in progress,
on shutdown. Each pass is one transaction of the system runner:
`select ... where status = 'pending' and next_attempt_at <= now() order by next_attempt_at,
created_at limit <batch> for update skip locked`, publish each row on the subject and to the stream
it stores, with `Nats-Msg-Id` set to its id, mark the published ones `sent` and, in the same
statement, [redact the restricted ones](#restricted-events). A row locked by one replica is
skipped by the others. The relay stops starting sends five seconds after receiving the rows.
It awaits the last send within the configured `publishTimeoutMs`, then settles the attempted rows
and commits. The unattempted rows stay pending. A full selection or a cut-short pass is followed
by another pass at once, subject to the backoff below. The legacy relay opts out of automatic
database transaction retries because a broker acknowledgement can precede a failed settlement.
A failed pass leaves redelivery to the relay's existing retry loop with the same event ID.
The relay records the time to enter the
transaction callback and the time from entry to commit or rollback in the millisecond histograms
`cadenway.outbox.relay.transaction.entry.duration` and `cadenway.outbox.relay.transaction.duration`.

A publish failure of one row leaves it pending, increments `attempts`, stores the class of the
error in `last_error` (never a message or a payload) and delays its next attempt from the time the
failure is recorded: 1 s, doubling, capped at five minutes. After 20 failed attempts the row is
parked (`status = 'failed'`) with one
error log, until `requeueOutboxEvents` gives it a new series; warnings about failing rows are
logged at most once a minute per class of error. A failure that concerns every row (NATS or the
stream unreachable, a timeout, a closed connection, a missing permission, the server out of
resources) stops the pass without counting against the row, and the relay backs off, doubling the
poll interval up to 30 seconds; so does a database failure. `relay.publishPending()` runs one
pass by hand outside an active transaction and returns `{ published, failed, interrupted }`.
At shutdown the relay stops
admitting manual and scheduled passes and waits for any passes already started to settle.

Automatic maintenance starts alongside the relay and runs independently of publication. It
redacts older restricted rows at startup, even when periodic sweeps are disabled. Each
transaction processes at most 100 rows. A PostgreSQL advisory lock coordinates the automatic
batches across replicas, and maintenance returns to skipped work on a later pass.

Manual maintenance functions, each taking the scope of a system transaction:

| Function                                       | Effect                                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `purgeSentOutboxEvents(tx, olderThanDays = 7)` | Deletes the rows sent before that age; pending rows are never deleted                                                                          |
| `purgeProcessedEvents(tx, olderThanDays = 14)` | Deletes the processed ids recorded before that age                                                                                             |
| `requeueOutboxEvents(tx, since)`               | Marks pending again the rows sent since `since`, to publish them again after a NATS loss, and the parked rows; never a redacted restricted row |

`DEFAULT_OUTBOX_RETENTION_DAYS` (7) and `DEFAULT_PROCESSED_EVENTS_RETENTION_DAYS` (14) are the
defaults of the two purges.

## Tables and migrations

| Table              | Columns                                                                                                                                                                                                                                                                                                              | Row-level security          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `outbox_events`    | `id uuid` primary key (the event id), `event_name`, `subject`, `stream`, `organization_id uuid` null, `payload jsonb`, `traceparent` null, `status` (`pending`, `sent`, `failed`, checked), `attempts`, `next_attempt_at`, `last_error` null, `created_at`, `sent_at` null; partial indexes on pending and sent rows | Organization policy, forced |
| `processed_events` | Primary key (`consumer`, `event_id`), `processed_at`, indexed                                                                                                                                                                                                                                                        | None: no organization data  |
| `event_versions`   | `consumer`, `organization_id uuid` null, `aggregate_key`, `version bigint`, `updated_at`; unique (`consumer`, `organization_id`, `aggregate_key`) with nulls not distinct                                                                                                                                            | Organization policy, forced |

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
ALTER TABLE "event_versions" FORCE ROW LEVEL SECURITY;
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
| Terminal consumer advisory guard           | `$JS.API.STREAM.INFO.<advisoryStream>`                                                                                                                                       | `_INBOX.<user>.>`                                                                                                      |
| Stream management (`manageStreams`, admin) | `$JS.API.STREAM.INFO.<stream>`, `$JS.API.STREAM.CREATE.<stream>`, `$JS.API.STREAM.UPDATE.<stream>` for the three streams                                                     | `_INBOX.<user>.>`                                                                                                      |
| Publish an event                           | `evt.<event>`, or `restricted.<event>` for a restricted one (a JetStream publish, acknowledged on the inbox)                                                                 | `_INBOX.<user>.>`                                                                                                      |
| Create or update a consumer                | `$JS.API.CONSUMER.INFO.<stream>.<service>__<handler>`, `$JS.API.CONSUMER.CREATE.<stream>.<service>__<handler>.<filter subject>`                                              | `_INBOX.<user>.>`                                                                                                      |
| Consume                                    | `$JS.API.CONSUMER.INFO.<stream>.<service>__<handler>`, `$JS.API.CONSUMER.MSG.NEXT.<stream>.<service>__<handler>`, `$JS.ACK.<stream>.<service>__<handler>.>` (ack, nak, term) | `_INBOX.<user>.>`                                                                                                      |
| Dead-letter worker                         | `$JS.API.STREAM.MSG.GET.EVENTS`, `$JS.API.STREAM.MSG.GET.EVENTS_RESTRICTED`, `dlq.<consumer>.<subject>`                                                                      | `$JS.EVENT.ADVISORY.CONSUMER.{MAX_DELIVERIES,MSG_TERMINATED}.{EVENTS,EVENTS_RESTRICTED}.>` (queue `EVENTS_DLQ-worker`) |
| Emit a rebuild                             | `rebuild.<consumer>.<entity>`                                                                                                                                                | `_INBOX.<user>.>` in the `reply` mode                                                                                  |
| Receive a rebuild                          | The reply subject of a request, in the `reply` mode only (`allow_responses`)                                                                                                 | `rebuild.<rebuildName>.<entity>` (queue `<rebuildName>`)                                                               |
| Readiness                                  | Nothing: a flush is a protocol ping                                                                                                                                          |                                                                                                                        |

The kit never calls `$JS.API.INFO`, `$JS.API.STREAM.NAMES`, `$JS.API.DIRECT.GET`, nor any consumer
delete, list or names API. The integration spec `src/wiring/messaging.module.int-spec.ts` runs it against
a server configured like cadenway-ops.

## Limits

- One message at a time per handler and per replica: throughput per handler is bounded by the
  handler latency; scale with replicas.
- A handler is abandoned at `handlerTimeoutMs`, not stopped: work that ignores `signal` goes on
  in the background, though its writes through the runners are rolled back with the transaction
  of the deduplicator. The kit does not extend `AckWait` with progress acknowledgements.
- Dead letters rely on advisories, which are not stored: none is copied while no worker runs.
- A new consumer with the default `deliverPolicy: 'all'` receives what its stream still holds, up
  to seven days of events; a handler with outside effects (notifications) registers with `new`.
- A handler still running after `shutdownTimeoutMs` is abandoned and its message redelivered.
- A rebuild is not durable and, in the default mode, lossy; the stream is not an archive.
- The relay does not reorder events and the consumers do not serialize them.
- The route of an outbox row is decided by the replica that writes it: listing an event in
  `restrictedEvents` does not move rows already written.
- A restricted event cannot be published again from the outbox once sent: its payload is redacted.
- `processed_events` is keyed by consumer and event id only, not by organization: event ids are
  UUIDs unique across organizations.

## Stable formats

These are read by other services, other versions of the kit or operators, and change only in a
major, with a migration note per service:

| Format              | Value                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subjects            | `evt.<event>`, `restricted.<event>`, `dlq.<consumer>.<original subject>`, `rebuild.<consumer>.<entity>`                                                                                |
| Durable consumers   | `<service>__<handler>`, filtered on one subject                                                                                                                                        |
| Event headers       | `Nats-Msg-Id` (the event id), `Cadenway-Event-Name`, `Cadenway-Organization-Id` (absent without organization), `traceparent`                                                           |
| Dead-letter headers | `Cadenway-Dead-Letter-Consumer`, `-Reason` (`max-deliveries`, `terminated`), `-Stream-Sequence`, `-Deliveries`, `-Payload` (`dropped`); `Nats-Msg-Id` `<stream>.<consumer>.<sequence>` |
| Rebuild reply       | `{"ok":true}` or `{"ok":false,"reason":"<reason>"}`; an emitter reads a reason it does not know as a rejection                                                                         |
| Tables              | `outbox_events` (key `id`), `processed_events` (key `consumer`, `event_id`), `event_versions` (unique `consumer`, `organization_id`, `aggregate_key`, nulls not distinct)              |
| Redacted payload    | Payload of a sent restricted outbox row: `{ id, occurredAt, organizationId, actor, version, "$redacted": true }`; the `$redacted` key marks it                                         |
