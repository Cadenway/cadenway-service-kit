---
paths:
  - 'packages/**/*.spec.ts'
---

# Tests

- Vitest; integration tests with real NATS and PostgreSQL in Docker.
- Cover failure paths (crash after commit, redelivery, reconnection), not only the happy path.
