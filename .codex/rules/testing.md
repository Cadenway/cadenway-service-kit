---
paths:
  - 'packages/**/*.spec.ts'
---

# Tests

- Vitest; integration tests with real NATS and PostgreSQL in Docker.
- Cover failure paths (crash after commit, redelivery, reconnection), not only the happy path.
- Disposable PostgreSQL, NATS and Redis come from Testcontainers, on the image tags cadenway-ops
  pins. JetStream is off by default in the NATS module: start it with `withJetStream()`.
- Third-party HTTP (payment, Git providers, identity providers) is faked with `msw`; a test never
  calls a live service.
