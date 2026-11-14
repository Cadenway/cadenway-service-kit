# Architecture and ownership

[Documentation index](README.md) · [Repository instructions](../AGENTS.md)

## Status

The checkout contains three runtime packages. Their package manifests document the implemented exports.

## Purpose and target structure

cadenway-service-kit publishes the three runtime packages shared by NestJS services and gateways.

| Package                    | Provides                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cadenway/nest-common`    | Typed configuration validated at start-up, internal-token guard, organization context, structured logs, OpenTelemetry traces, `/health/live` and `/health/ready`, common error format, pagination |
| `@cadenway/nest-messaging` | NATS JetStream connection, outbox publication, subscriptions with retries and dead letters, deduplication of redelivered events                                                                   |
| `@cadenway/nest-jobs`      | Durable background jobs kept in the service's own PostgreSQL database: a job enqueued in the use case transaction, retries with backoff, dead letters, cron schedules                             |

## Architectural ownership

- [Hexagonal architecture for NestJS services](hexagonal-architecture.md) defines the service and gateway profiles and module template. The architecture verifier is provided by [`@cadenway/nest-testing/architecture`](https://github.com/Cadenway/cadenway-tooling/tree/main/packages/nest-testing) from cadenway-tooling.
- `packages/nest-common/`, `packages/nest-messaging/`, `packages/nest-jobs/`: one runtime module or helper set each.

## Boundaries

- No business logic, no knowledge of a specific service.
- No direct dependency on a service repository.
- Public API through explicit exports; breaking changes are majors with a deprecation first.

## Cross-repository changes

Each checkout owns its implementation and release. Use published `@cadenway/*` packages instead of sibling source imports or local dependency links. For contract changes, make the contract and generated package available first, then update the producing service, gateways and listeners, and finally the webapp. Each step should remain deployable independently.
