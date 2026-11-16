# Architecture and ownership

[Documentation index](README.md) · [Repository instructions](../AGENTS.md)

## Status

The checkout contains three runtime packages and a shared health module. Their package manifests document the implemented exports.

## Purpose and target structure

cadenway-service-kit publishes the three runtime packages shared by NestJS services and gateways.

| Package                    | Provides                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cadenway/nest-common`    | Typed configuration validated at start-up, internal-token guard, organization context, structured logs, OpenTelemetry traces, `/health/live` and `/health/ready`, common error format, pagination |
| `@cadenway/nest-messaging` | NATS JetStream connection, outbox publication, subscriptions with retries and dead letters, deduplication of redelivered events                                                                   |
| `@cadenway/nest-jobs`      | Durable background jobs kept in the service's own PostgreSQL database: a job enqueued in the use case transaction, retries with backoff, dead letters, cron schedules                             |

## Architectural ownership

- [Hexagonal architecture for NestJS services](hexagonal-architecture.md) defines the service and gateway profiles and module template. The architecture verifier is provided by [`@cadenway/nest-testing/architecture`](https://github.com/Cadenway/cadenway-tooling/tree/main/packages/nest-testing) from cadenway-tooling.
- `packages/nest-common/` owns request context, bootstrap and the shared runtime interfaces.
  The token guard and database idempotency share the request context without coupling database code
  to the guard. The database, Redis and telemetry entry points expose their respective mechanisms.
- `packages/nest-messaging/` owns JetStream subscriptions, delivery and recovery, with
  `EventConsumers` as the Nest provider. The rebuild emitter and consumer share the reply codec.
  PostgreSQL outbox components remain behind `/outbox`.
- `packages/nest-jobs/` owns durable jobs through its root entry point. The runtime starts workers
  under the application role. Provisioning owns DDL and uses the migrator role. Both use the same
  schema identity and version.

## Boundaries

- No business logic, no knowledge of a specific service.
- No direct dependency on a service repository.
- Public API through explicit exports; breaking changes are majors with a deprecation first.

## Package checks and evolution

Build the kit and run `pnpm test:packaging` to check installed archives, TypeScript signatures
and runtime entry points. Exercise root imports with mandatory peers and exercise driver-specific
entry points with their optional peers installed. Keep architecture checks independent of containers.
Keep validation of transactions, redelivery and PostgreSQL roles in the integration suites.

Choose a new public entry point when an actual consumer needs to isolate a driver, an initialization
effect or an independently useful API. Keep the existing facade as a compatibility entry.
For a pg-boss upgrade, run the previous and candidate runtimes against the migrated schema. When
they cannot coexist, document and exercise the stop, provision, start and recovery sequence before
releasing. Record the supported toolchain versions exercised by the consumer checks.

## Cross-repository changes

Each checkout owns its implementation and release. Use published `@cadenway/*` packages instead of sibling source imports or local dependency links. For contract changes, make the contract and generated package available first, then update the producing service, gateways and listeners, and finally the webapp. Each step should remain deployable independently.
