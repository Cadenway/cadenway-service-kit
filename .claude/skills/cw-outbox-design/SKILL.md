---
name: cw-outbox-design
description: "Change nest-messaging outbox, relay, deduplication, retry or dead letters."
---

# Outbox design

```text
use case transaction ──► outbox row (pending)
commit ──► relay picks pending rows ──► NATS JetStream publish ──► row marked sent
consumer ──► processed-ids check ──► handler ──► ack
failure ──► retry with backoff (max n) ──► dead-letter stream + error log
```

The relay and handlers of events without an organization use the system transaction runner of
`@cadenway/nest-common/database`. Handlers of events that carry an organization use the tenant
runner scoped to the organization in the validated envelope.

Read the relevant guidance before changing messaging.

- [Transport conventions](../../../docs/integration.md#transport-conventions) for subjects,
  delivery, ordering, retry, dead letters and redaction.
- [Redelivery schedule](../../../packages/nest-messaging/README.md#redelivery-schedule) for
  subscription overrides, startup validation and updates to existing consumers.
- [Rebuild](../../../docs/integration.md#rebuild) for retention, recovery and index rebuilds.
- [Without a database](../../../docs/integration.md#without-a-database) for package entry points
  and optional peers.
