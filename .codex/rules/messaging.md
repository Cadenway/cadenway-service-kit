---
paths:
  - 'packages/nest-messaging/**'
---

# Messaging

- At-least-once delivery: outbox in the caller's transaction, relay after commit, deduplication on
  event id, bounded retries, dead-letter stream.
- Trace id and organization id travel in message headers.
- An outbox schema change ships its migration and a note for every service.
