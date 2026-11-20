---
'@cadenway/nest-common': minor
---

Retry outermost PostgreSQL transactions on deadlocks and serialization failures, with three total attempts by default. Set the owning transaction's attempt limit to 1 to opt out, either on the database module, on the runner call, or on a route using `@Idempotent`. Check each callback for external side effects before adopting retries.
