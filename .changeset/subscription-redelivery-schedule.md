---
'@cadenway/nest-messaging': minor
---

Let a subscription choose its own redelivery schedule. `EventConsumers.subscribe` accepts an
optional `redelivery: { delaysMs, maxDeliveries? }` (type `EventRedelivery`, exported from the
main entry point): the delay before each redelivery of a failing message, the last one repeating,
and the number of deliveries before its dead letter, the `max_deliver` of the durable consumer
(one more than the delays by default). A handler without `redelivery` keeps the default schedule
(1 s, 5 s, 30 s, 2 min, five deliveries): nothing changes for existing registrations.

- The schedule is applied with `nak(delay)`; the consumer keeps its 30 s `AckWait` and gets no
  server-side `BackOff`.
- `subscribe` rejects an invalid schedule before any broker request, so the application does not
  start: a delay that is not a whole number of milliseconds from 1, a `maxDeliveries` that is not a
  whole number above the number of delays (JetStream requires `max_deliver` to exceed a backoff
  list), an empty list with more than one delivery, or a schedule that, counting one 30 s
  `AckWait` per delivery, outlasts the retention of its stream (seven days for `EVENTS`, one hour
  for `EVENTS_RESTRICTED`).
- With `manageConsumers` (the default), the `max_deliver` of an existing durable consumer is
  updated in place, keeping its position and pending messages, and the update is logged
  (`durable consumer updated in place`). A pending message continues with the new limit; one that
  already reached a lowered limit becomes a dead letter without another delivery. With
  `manageConsumers` off, a registration with its own `redelivery` refuses to start unless the
  consumer created elsewhere already has that `max_deliver`.

Migration: none required. A service that adopts a schedule for a handler sees that handler's
consumer updated on its next start; its NATS user already needs `$JS.API.CONSUMER.CREATE` on its
own consumer names, which the update uses. The README documents a schedule of at least 24 hours
before the dead letter for security projections.
