---
'@cadenway/nest-common': patch
'@cadenway/nest-messaging': patch
'@cadenway/nest-jobs': patch
---

Group internal modules and their tests by responsibility while preserving the published entry points.

- Give each PostgreSQL transaction its own Drizzle scope, enforce nested read-only requests, share in-flight readiness probes, bound HTTP error decoding, and separate idempotency storage from HTTP handling.
- Preserve HTTP failure classification during response body cleanup.
- Bound rebuild admission, dead-letter shutdown and outbox passes. Recover deleted durable consumers from retained events, prevent overlapping registrations and expired handler starts, and run outbox maintenance separately in coordinated batches.
- Apply the Jobs grace period to individual attempts, observe visible dead-letter stock outside the startup path, and separate PostgreSQL startup checks and retention diagnostics from the runtime lifecycle.
