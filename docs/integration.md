# Domain and integration

[Documentation index](README.md) · [Repository instructions](../AGENTS.md)

**Status:** This page records the target design from repository instructions and skills. Its behavior has not been verified as implemented in this snapshot.

## Package boundaries

`@cadenway/nest-common`, `@cadenway/nest-messaging`, and `@cadenway/nest-jobs` provide shared backend runtime plumbing. Services consume published releases and own their business rules. Test infrastructure and architecture verification belong to [`@cadenway/nest-testing`](https://github.com/Cadenway/cadenway-tooling/tree/main/packages/nest-testing) in cadenway-tooling. Package APIs and delivery behavior below are planned until implementation exists.

## Kit API Stability

Source: `cw-kit-api-stability` ([Claude](../.claude/skills/cw-kit-api-stability/SKILL.md), [Codex](../.codex/skills/cw-kit-api-stability/SKILL.md)).

- New behavior: behind an option, default unchanged.
- Rename or removal: deprecate in a minor (JSDoc `@deprecated`, a start-up warning), remove in the next
  major with a migration note per affected service.

## Internal Token, Organization Context And Transactions

Source: rule `common.md` ([Claude](../.claude/rules/common.md), [Codex](../.codex/rules/common.md)).

### Internal token

| Concern      | Rule                                                                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format       | A JWT signed with `alg: Ed25519`, valid 60 seconds, with `aud` set to the called service and a `kid` header                                                                      |
| Issuers      | The API gateway, the realtime gateway, automation-service and integration-service. A service calls another one to act, never to read                                             |
| Keys         | Signing keys, trusted issuers and their verification keys come from configuration. A verification key is accepted only for the issuer it is configured under                     |
| Subject      | A user, an automation, a Git integration, the system, or anonymous                                                                                                               |
| Routes       | The default requires an organization and refuses an anonymous subject. A route with no user or organization (sign-up, sign-in, introspection, intake form, webhooks) declares it |
| Organization | Taken from the verified token only, carried in an `AsyncLocalStorage`; never from a path, a query string or a body                                                               |

### Transaction runners

`drizzle-orm` and `pg` are optional peers behind the `/database` entry point of `@cadenway/nest-common`.

| Runner | Used by                                                                                  | Issues                                                              |
| ------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Tenant | A use case acting for one organization                                                   | `SET LOCAL app.organization_id`, read from the organization context |
| System | Work that crosses organizations: outbox relay, schedules, events without an organization | `SET LOCAL app.system_access`                                       |

Two PostgreSQL roles per service: `<svc>_migrator` runs the migrations, `<svc>_app` runs the service and is subject to the row-level security policies. Nothing else opens a transaction or sets these parameters.

### Idempotency-Key

| Concern    | Rule                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------- |
| Owner      | An interceptor of `@cadenway/nest-common`; the gateway relays the header and stores nothing       |
| Storage    | A table in the service's own database, written inside the use case transaction                    |
| Conflicts  | The same key with another body answers 422; a request still running answers 409                   |
| Replay     | The stored response is replayed for 24 hours                                                      |
| Migrations | The table reaches a service through its own Drizzle migrations; a change ships a note per service |

## Outbox Design

Source: `cw-outbox-design` ([Claude](../.claude/skills/cw-outbox-design/SKILL.md), [Codex](../.codex/skills/cw-outbox-design/SKILL.md)).

```text
use case transaction ──► outbox row (pending)
commit ──► relay picks pending rows ──► NATS JetStream publish ──► row marked sent
consumer ──► processed-ids check ──► handler ──► ack
failure ──► retry with backoff (max n) ──► dead-letter stream + error log
```

### Transport conventions

| Concern      | Rule                                                                                                                                                                                                                                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subject      | `evt.<event-name>`, derived from the contract name: `evt.task.status-changed.v1`                                                                                                                                                                                                                                                   |
| Stream       | One stream `EVENTS` on `evt.>`: file storage, seven days, a byte cap. Restricted identity events on `restricted.<name>` in `EVENTS_RESTRICTED`. cadenway-ops creates the streams                                                                                                                                                   |
| Publish      | `Nats-Msg-Id` = event id; the server deduplicates for two minutes only                                                                                                                                                                                                                                                             |
| Consumer     | Durable pull consumer `<service>__<handler>` with one filter subject, `AckWait` 30 s, five deliveries by default; `max_deliver` updated in place; never listed or deleted by the kit                                                                                                                                               |
| Retry        | `nak(delay)` after 1 s, 5 s, 30 s, 2 min, or the subscription's own `redelivery` (delays, last one repeated, and `maxDeliveries`), checked at start-up; no server-side `BackOff`, whose first entry replaces `AckWait`                                                                                                             |
| Dead letters | A worker in notification-service only listens to the `MAX_DELIVERIES` and `MSG_TERMINATED` advisories of `EVENTS` and `EVENTS_RESTRICTED` and copies the message to `dlq.<consumer>.<subject>` in `EVENTS_DLQ`: JetStream has no dead-letter queue of its own                                                                      |
| Ordering     | Not guaranteed. Every event carries the `version` of its aggregate; a consumer skips a version it has already applied                                                                                                                                                                                                              |
| Headers      | `traceparent` (W3C), organization id, event name                                                                                                                                                                                                                                                                                   |
| Payload      | JSON, validated with the zod schema of `@cadenway/contracts` on publish and on receipt                                                                                                                                                                                                                                             |
| Redaction    | The statement that marks a restricted row sent keeps only the envelope and `"$redacted": true` in its payload; the message carries the full payload. A failed publish keeps it for the next attempt; a redacted row is never requeued nor published again; rows an older kit sent whole are redacted at start and with every purge |
| Publisher    | One NATS user per service, allowed to publish its own subjects only, on the inbox prefix `_INBOX.<user>`                                                                                                                                                                                                                           |

### Rebuild

Sent outbox rows are kept seven days, so a service can publish again after a NATS loss, except a
redacted restricted row: its owner issues a new code or link instead. The stream
is not an archive: an index is rebuilt by the owning service re-emitting the current state of its
entities on `rebuild.<consumer>.<entity>`, where `<consumer>` is the NATS user of the consumer. These
messages are plain NATS and unacknowledged by default: the broker gives no user the right to reply.

### Without a database

`drizzle-orm` and `pg` are optional peers. The outbox and the processed-ids table sit behind the
`/outbox` entry point; the realtime gateway, which has no database, consumes events through the main
entry point only.

## Logging And Tracing

Source: `cw-logging-and-tracing` ([Claude](../.claude/skills/cw-logging-and-tracing/SKILL.md), [Codex](../.codex/skills/cw-logging-and-tracing/SKILL.md)).

All of it comes from `@cadenway/nest-common`. An application never configures pino or the
OpenTelemetry SDK itself.

### Logs

| Concern      | Rule                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format       | One JSON line per event, through `nestjs-pino`                                                                                                                      |
| Fields       | `service`, `version`, `traceId`, `spanId`, `organizationId`, `userId`, `route`, `status`, `durationMs`, the request id                                              |
| Redaction    | Tokens, passwords, cookies, the `authorization` header, two-step verification secrets and e-mail addresses are masked by default; no e-mail address or IP at `info` |
| Never logged | Request bodies, SQL values, query strings                                                                                                                           |
| Level        | `LOG_LEVEL`; `pino-pretty` is a development transport, never a production one                                                                                       |

### Traces

| Concern          | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Propagation      | `traceparent` (W3C) in HTTP headers and in NATS message headers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Start-up         | `NODE_OPTIONS="--max-old-space-size=160" node --import @cadenway/nest-common/register --import ./telemetry.js main.js`: the hooks registered with `module.register()` instrument an ESM application, and NestJS 12 imports Express as ESM. The kit entry point resolves `@opentelemetry/instrumentation/hook.mjs`, which an application cannot resolve itself under pnpm; `--experimental-loader=@cadenway/nest-common/hook.mjs` still works but prints an `ExperimentalWarning` at every start. The heap cap is about 60 % of a 256M container |
| Instrumentations | HTTP, Express, pg, ioredis and undici, listed one by one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Route name       | An interceptor names the span and sets `http.route`: no OpenTelemetry instrumentation supports NestJS 12                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Export           | OTLP over HTTP to `OTEL_EXPORTER_OTLP_ENDPOINT`; nothing leaves the process when the variable is unset                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### Metrics

| Scope      | Measured                                               |
| ---------- | ------------------------------------------------------ |
| Each route | Rate, errors, duration                                 |
| Messaging  | Outbox lag, consumer lag; an alert fires past 24 hours |
| Runtime    | PostgreSQL pool use, event-loop delay                  |

### Not installed, on purpose

- `@opentelemetry/instrumentation-nestjs-core`: its supported range stops before NestJS 12.
- `@opentelemetry/instrumentation-router`: it duplicates the spans of Express 5.

## Background Jobs

Source: `cw-jobs` ([Claude](../.claude/skills/cw-jobs/SKILL.md), [Codex](../.codex/skills/cw-jobs/SKILL.md)).

Jobs live in the service's own PostgreSQL database, through `@cadenway/nest-jobs` (`pg-boss`). There
is no in-process timer: work held in memory is lost on a restart, and every replica would run it.

| Concern         | Rule                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Enqueue         | In the transaction of the use case: the job exists if and only if the data does. `JobsService.enqueue(tx, ...)` takes the scope of the tenant or system transaction runner of `@cadenway/nest-common/database`                                                                                                                                                                                               |
| Source of truth | The business table (`due_at`, `sent_at`), not the queue: a schedule claims due rows with `FOR UPDATE SKIP LOCKED`                                                                                                                                                                                                                                                                                            |
| Occurrence key  | A unique key per occurrence within its organization, such as `(reminder_id, occurrence)`, makes a second run a no-op                                                                                                                                                                                                                                                                                         |
| Sends           | One job per e-mail or webhook delivery; the idempotency key is the delivery id                                                                                                                                                                                                                                                                                                                               |
| Retries         | Bounded, with exponential backoff; then the dead-letter queue and an error log. The worker logs attempts that fail, expire or are interrupted at shutdown. By default each replica also reports the retained stock in non-empty dead-letter queues every minute, including rejects recorded after a worker crash. Counts are capped at 1,000 per queue.                                                      |
| Schedules       | Cron with an explicit time zone, never the server's local time                                                                                                                                                                                                                                                                                                                                               |
| Guarantee       | At least once. Every handler is idempotent: "never twice" cannot be promised over SMTP or HTTP                                                                                                                                                                                                                                                                                                               |
| Connections     | A pool of two, apart from the application pool                                                                                                                                                                                                                                                                                                                                                               |
| Roles           | pg-boss's own schema is installed, migrated and granted by `provisionJobs`, called from the migration entry point as `<svc>_migrator`: it holds every DDL statement, creates the declared queues and their dead-letter queues, and grants `<svc>_app` data access only. The service runs its jobs as `<svc>_app`, without any DDL right, and refuses to start when the schema or a queue was not provisioned |

### What runs as a job

- Reminders, daily digests and due-date alerts.
- Purges: the trash, the audit log, expired sessions, codes and links.
- Outgoing webhook deliveries and their retries.

## References

[Interactive mockup](https://claude.ai/artifact/KYRM7AnsYLiBLBLKy8i4HE), [integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et), and [repositories and packages](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N). Use [AGENTS.md](../AGENTS.md) as the local source for ownership and hard limits.
