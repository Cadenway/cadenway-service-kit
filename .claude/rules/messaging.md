---
paths:
  - 'packages/nest-messaging/**'
---

# Messaging

Use `cw-outbox-design` and the [transport conventions](../../docs/integration.md#transport-conventions).
Persist the outbox in the caller's transaction, publish after commit and deduplicate by event
id on receipt. The two-minute `Nats-Msg-Id` window does not replace durable deduplication.
Validate the payload against `@cadenway/contracts` on publish and receipt, propagate
`traceparent` and organization id, and skip aggregate versions already applied.

Derive subjects such as `evt.task.status-changed.v1` from the event name. The normal `EVENTS` stream
has file storage, seven-day retention and a byte cap. Each service uses its own `NATS_USER` and `NATS_PASSWORD`,
publishes only its subjects and subscribes through its own `_INBOX.<user>` prefix. Ops owns
`EVENTS`, `EVENTS_RESTRICTED` and `EVENTS_DLQ`; keep `manageStreams` off outside local tests.
The kit only creates and updates its own durable pull consumers. Use one exact filter per
`<service>__<handler>`, `AckWait` of 30 s and five deliveries by default. Retry with `nak(delay)`
after 1 s, 5 s, 30 s and 2 min, without server-side `BackOff`. A subscription with custom
`redelivery` must pass the startup checks for `max_deliver` and stream retention. The kit updates
`max_deliver` in place when it manages the consumer. Follow the
[redelivery schedule](../../packages/nest-messaging/README.md#redelivery-schedule) for the validation
and externally managed consumers.

Only identity-service publishes restricted single-use codes or links, and only notification-service
consumes them. List restricted names in `restrictedEvents` and publish them on `restricted.<name>`;
other events use `evt.>`. Keep the [restricted outbox lifecycle](../../packages/nest-messaging/README.md#restricted-events)
and [dead-letter protocol](../../docs/integration.md#transport-conventions), including
`STREAM.MSG.GET`. Only notification-service may enable `deadLetterWorker`, which defaults to off.

Keep sent rows seven days. Follow the [rebuild protocol](../../docs/integration.md#rebuild) for NATS
loss, redacted rows and current-state replay. Keep database dependencies optional behind
`/outbox`. The relay and handlers without an organization use the system runner. Handlers
with an organization use the tenant runner scoped to the validated envelope. Outbox schema
changes ship a migration and a note for every service.

## Review example

For a relay change, exercise a publication that fails before acknowledgement and a later
redelivery. Check that a failed or slow publish leaves the database available for other work,
the backlog can drain after recovery, and a duplicate does not repeat the consumer's business
effect. Use the repository's performance checks for throughput and pool contention claims.
