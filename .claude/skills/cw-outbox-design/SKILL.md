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
| Stream | One stream `EVENTS` on `evt.>`: file storage, seven days, a byte cap |
| Publish | `Nats-Msg-Id` = event id; the server deduplicates for two minutes only |
| Consumer | Durable pull consumer `<service>__<handler>`, `AckWait` 30 s, five deliveries |
| Retry | `nak(delay)` after 1 s, 5 s, 30 s, 2 min; no server-side `BackOff`, whose first entry replaces `AckWait` |
| Dead letters | A worker listens to `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.EVENTS.>` and copies the message into `EVENTS_DLQ`: JetStream has no dead-letter queue of its own |
| Ordering | Not guaranteed. Every event carries the `version` of its aggregate; a consumer skips a version it has already applied |
| Headers | `traceparent` (W3C), organization id, event name |
| Payload | JSON, validated with the zod schema of `@cadenway/contracts` on publish and on receipt |
| Publisher | One NATS user per service, allowed to publish its own subjects only |

## Rebuild

Sent outbox rows are kept seven days, so a service can publish again after a NATS loss. The stream
is not an archive: an index is rebuilt by the owning service re-emitting the current state of its
entities on `rebuild.<consumer>.<entity>`.

## Without a database

`drizzle-orm` and `pg` are optional peers. The outbox and the processed-ids table sit behind the
`/outbox` entry point; the realtime gateway, which has no database, consumes events through the main
entry point only.
