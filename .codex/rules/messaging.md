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
- The identity events that carry a single-use code or link live on `restricted.<event-name>`, in
  `EVENTS_RESTRICTED`: identity publishes them, notification alone consumes them. A service lists
  them in the `restrictedEvents` option; nothing else is published outside `evt.>`.
- The statement that marks a restricted outbox row sent replaces its payload with the envelope
  and `"$redacted": true`: the code or link travels in the message only. A failed publish keeps
  the payload for the next attempt; a redacted row is never requeued nor published again. Rows an
  older kit sent whole are redacted by the relay at start and with every purge. The table schema
  does not change.
- cadenway-ops creates the three streams (`EVENTS`, `EVENTS_RESTRICTED`, `EVENTS_DLQ`): a service
  never creates, changes or deletes a stream outside local tests (`manageStreams` stays off).
- Publish with `Nats-Msg-Id` set to the event id. The server deduplicates inside its two-minute
  window only: the processed-ids table of the consumer is the real guard.
- Consumers are durable pull consumers named `<service>__<handler>`: `AckWait` 30 s, five deliveries,
  retries by `nak(delay)` after 1 s, 5 s, 30 s and 2 min, unless the subscription sets its own
  `redelivery` (delays and `maxDeliveries`, checked at start-up against `max_deliver` and the stream
  retention). No server-side `BackOff`: its first entry replaces `AckWait`. A consumer has one
  filter subject, never `evt.>`; the kit creates and updates its own consumers but never lists or
  deletes one (the broker refuses it).
- JetStream has no dead-letter queue: a worker listens to the `MAX_DELIVERIES` and `MSG_TERMINATED`
  advisories of `EVENTS` and `EVENTS_RESTRICTED`, reads the message with `STREAM.MSG.GET` and copies
  it to `dlq.<consumer>.<subject>` in `EVENTS_DLQ`. It runs in notification-service only, the one
  backend allowed to read a restricted event (`deadLetterWorker`, off by default).
- Every event carries the `version` of its aggregate. A consumer skips a version it has already
  applied, so a late redelivery never overwrites a newer state.
- Sent outbox rows are kept seven days, to publish again after a NATS loss; a redacted restricted
  row cannot be, its owner issues a new code. An index is rebuilt by its owner re-emitting current
  state on `rebuild.<consumer>.<entity>`, never by replaying the stream. `<consumer>` is the NATS user of the consumer (`rebuild.search.task`); the messages are plain NATS
  and unacknowledged by default, because the broker gives no user the right to reply.
- The trace context travels as `traceparent` (W3C). Payloads are validated with the zod schemas of
  `@cadenway/contracts` on publish and on receipt.
- `drizzle-orm` and `pg` are optional peers: the outbox sits behind the `/outbox` entry point, so a
  gateway without a database can still consume events.
- Each service connects with its own NATS user (`NATS_USER`, `NATS_PASSWORD`), allowed to publish
  its own subjects only, and with the inbox prefix `_INBOX.<user>`, the only one it may subscribe to.
- The outbox relay and the handler of an event without an organization run in the system
  transaction runner of `@cadenway/nest-common/database`. The handler of an event that carries an
  organization runs in the tenant runner, with the organization of the validated envelope.
