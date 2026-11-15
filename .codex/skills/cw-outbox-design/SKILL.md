---
name: cw-outbox-design
description: "How the outbox, the relay, deduplication, retries and dead letters of @cadenway/nest-messaging work together. Load it before changing messaging."
---

# Outbox design

```text
use case transaction ──► outbox row (pending)
commit ──► relay picks pending rows ──► NATS JetStream publish ──► row marked sent
consumer ──► processed-ids check ──► handler ──► ack
failure ──► retry with backoff (max n) ──► dead-letter stream + error log
```

## Transport conventions

| Concern | Rule |
| --- | --- |
| Subject | `evt.<event-name>`, derived from the contract name: `evt.task.status-changed.v1` |
| Stream | One stream `EVENTS` on `evt.>`: file storage, seven days, a byte cap. Restricted identity events on `restricted.<name>` in `EVENTS_RESTRICTED`. cadenway-ops creates the streams |
| Publish | `Nats-Msg-Id` = event id; the server deduplicates for two minutes only |
| Consumer | Durable pull consumer `<service>__<handler>` with one filter subject, `AckWait` 30 s, five deliveries; never listed or deleted by the kit |
| Retry | `nak(delay)` after 1 s, 5 s, 30 s, 2 min; no server-side `BackOff`, whose first entry replaces `AckWait` |
| Dead letters | A worker in notification-service only listens to the `MAX_DELIVERIES` and `MSG_TERMINATED` advisories of `EVENTS` and `EVENTS_RESTRICTED` and copies the message to `dlq.<consumer>.<subject>` in `EVENTS_DLQ`: JetStream has no dead-letter queue of its own |
| Ordering | Not guaranteed. Every event carries the `version` of its aggregate; a consumer skips a version it has already applied |
| Headers | `traceparent` (W3C), organization id, event name |
| Payload | JSON, validated with the zod schema of `@cadenway/contracts` on publish and on receipt |
| Redaction | The statement that marks a restricted row sent keeps only the envelope and `"$redacted": true` in its payload; the message carries the full payload. A failed publish keeps it for the next attempt; a redacted row is never requeued nor published again; rows an older kit sent whole are redacted at start and with every purge |
| Publisher | One NATS user per service, allowed to publish its own subjects only, on the inbox prefix `_INBOX.<user>` |
| Transactions | The relay and the handler of an event without an organization use the system transaction runner of `@cadenway/nest-common/database`; the handler of an event that carries an organization uses the tenant runner, with the organization of the validated envelope |

## Rebuild

Sent outbox rows are kept seven days, so a service can publish again after a NATS loss, except a
redacted restricted row: its owner issues a new code or link instead. The stream
is not an archive: an index is rebuilt by the owning service re-emitting the current state of its
entities on `rebuild.<consumer>.<entity>`, where `<consumer>` is the NATS user of the consumer. These
messages are plain NATS and unacknowledged by default: the broker gives no user the right to reply.

## Without a database

`drizzle-orm` and `pg` are optional peers. The outbox and the processed-ids table sit behind the
`/outbox` entry point; the realtime gateway, which has no database, consumes events through the main
entry point only.
