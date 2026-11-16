---
'@cadenway/nest-common': patch
'@cadenway/nest-jobs': patch
'@cadenway/nest-messaging': patch
---

Respect shutdown grace for durable deliveries and drain active manual outbox passes. Bound dead-letter advisory queues and validate lease prerequisites and runtime timer settings before starting work.

Verify the Jobs database before activating pg-boss and keep nested transactions bound to their original pool and schema. Redact SQL and handler diagnostics and discard unused upstream authentication responses promptly.

Clarify the runtime contracts in the published documentation comments and give production classes
their own implementation files behind the existing public entry points.
