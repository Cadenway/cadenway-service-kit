# Architecture and ownership

[Documentation index](README.md) · [Repository instructions](../AGENTS.md)

## Status

At the time this documentation was written, this checkout has no `package.json`, application source tree, or GitHub workflow files. The target architecture, scripts, and workflows in this guide must be created and verified during bootstrap.

The following architecture is the target recorded in [AGENTS.md](../AGENTS.md). Paths and integrations are design boundaries, not evidence that files or services already exist.

## Purpose and target structure

cadenway-service-kit is the technical base shared by the NestJS services and gateways. It publishes four packages; the front end never depends on it.

| Package                    | Provides                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cadenway/nest-common`    | Typed configuration validated at start-up, internal-token guard, organization context, structured logs, OpenTelemetry traces, `/health/live` and `/health/ready`, common error format, pagination |
| `@cadenway/nest-messaging` | NATS JetStream connection, outbox publication, subscriptions with retries and dead letters, deduplication of redelivered events                                                                   |
| `@cadenway/nest-jobs`      | Durable background jobs kept in the service's own PostgreSQL database: a job enqueued in the use case transaction, retries with backoff, dead letters, cron schedules                             |
| `@cadenway/nest-testing`   | Disposable PostgreSQL, NATS and Redis for tests, fakes of third-party HTTP services, mockup-based fixtures (Atelier Nord, Sprint 14)                                                              |

## Architectural ownership

- `packages/nest-common/`, `packages/nest-messaging/`, `packages/nest-jobs/`, `packages/nest-testing/`: one Nest module or helper set each.

## Boundaries

- No business logic, no knowledge of a specific service.
- No direct dependency on a service repository.
- Public API through explicit exports; breaking changes are majors with a deprecation first.

## Cross-repository changes

Each checkout owns its implementation and release. Use published `@cadenway/*` packages instead of sibling source imports or local dependency links. For contract changes, make the contract and generated package available first, then update the producing service, gateways and listeners, and finally the webapp. Each step should remain deployable independently.
