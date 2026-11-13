---
paths:
  - 'packages/nest-messaging/**'
---

# Messaging

- At-least-once delivery: outbox in the caller's transaction, relay after commit, deduplication on
  event id, bounded retries, dead-letter stream.
- Trace id and organization id travel in message headers.
- An outbox schema change ships its migration and a note for every service.
- Subjects are derived, never typed by hand: `evt.<event-name>`, for example
  `evt.task.status-changed.v1`. One stream, `EVENTS`, on `evt.>`: file storage, seven days, a byte cap.
- Publish with `Nats-Msg-Id` set to the event id. The server deduplicates inside its two-minute
  window only: the processed-ids table of the consumer is the real guard.
- Consumers are durable pull consumers named `<service>__<handler>`: `AckWait` 30 s, five deliveries,
  retries by `nak(delay)` after 1 s, 5 s, 30 s and 2 min. No server-side `BackOff`: its first entry
  replaces `AckWait`.
- JetStream has no dead-letter queue: a worker listens to
  `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.EVENTS.>` and copies the message into `EVENTS_DLQ`.
- Every event carries the `version` of its aggregate. A consumer skips a version it has already
  applied, so a late redelivery never overwrites a newer state.
- Sent outbox rows are kept seven days, to publish again after a NATS loss. An index is rebuilt by
  its owner re-emitting current state on `rebuild.<consumer>.<entity>`, never by replaying the stream.
- The trace context travels as `traceparent` (W3C). Payloads are validated with the zod schemas of
  `@cadenway/contracts` on publish and on receipt.
- `drizzle-orm` and `pg` are optional peers: the outbox sits behind the `/outbox` entry point, so a
  gateway without a database can still consume events.
- Each service connects with its own NATS user, allowed to publish its own subjects only.
