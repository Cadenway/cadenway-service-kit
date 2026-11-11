---
name: wp-outbox-design
description: "How the outbox, the relay, deduplication, retries and dead letters of @waypoint/nest-messaging work together. Load it before changing messaging."
---

# Outbox design

```text
use case transaction ──► outbox row (pending)
commit ──► relay picks pending rows ──► NATS JetStream publish ──► row marked sent
consumer ──► processed-ids check ──► handler ──► ack
failure ──► retry with backoff (max n) ──► dead-letter stream + error log
```
