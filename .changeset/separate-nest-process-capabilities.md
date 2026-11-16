---
'@cadenway/nest-common': minor
'@cadenway/nest-messaging': minor
'@cadenway/nest-jobs': minor
---

Separate outbox writing, relay operations and PostgreSQL schema exports. The lease-based relay
publishes outside its claim and settlement transactions after the owning service has expanded
its outbox schema. Keep the existing outbox entry point available during the migration.
Expose PostgreSQL deduplication through a consumer module that is independent of the writer.

Separate Jobs runtime capabilities from provisioning and expose individual producer, worker
and scheduler APIs. The existing Jobs entry point remains available during the migration.

Separate PostgreSQL transaction execution from its public scope and runners, and expose pool
wait and transaction duration through OpenTelemetry.
