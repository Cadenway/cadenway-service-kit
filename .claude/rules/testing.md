---
paths:
  - 'packages/**/*.spec.ts'
---

# Tests

Use Vitest with real NATS and PostgreSQL in Docker for integration tests. Cover crashes after
commit, redelivery and reconnection. Use Testcontainers with cadenway-ops image tags for PostgreSQL, NATS and Redis. Enable
JetStream with `withJetStream()` (off by default). Fake third-party HTTP (payment, Git and
identity providers) with `msw`; tests never call live services.
