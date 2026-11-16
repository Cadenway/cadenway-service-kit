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
  PostgreSQL deduplication lives behind `/consumer/postgres`. Outbox writing and publication
  have independent entry points under `/outbox`. The legacy facade still composes deduplication.
- `packages/nest-jobs/` owns durable jobs. The `/runtime` entry point separates production, worker
  registration and scheduling. The `/provisioning` entry point owns DDL and uses the migrator role.
  Both use the same schema identity and version. The root entry remains available during migration.

## Source layout

| Package          | Responsibility folders                                                                                                                                                                                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nest-common`    | `bootstrap/{application,lifecycle}` groups application assembly and process lifecycle. `database/{connection,transactions,idempotency,policies,wiring}` groups the pool, transaction runners, idempotency, tenant policies and Nest module. `http/{body,client,concurrency,deadline,routing}`, `health/{checks,endpoints}` and `telemetry/{http,sdk}` group their own concerns. |
| `nest-messaging` | `configuration/`, `wiring/`, `transport/` and `observability/` own their respective cross-cutting responsibilities. `consumer/{subscriptions,delivery,recovery,postgres}` groups consumer behavior and its optional persistence adapter. `rebuild/{codec,emitter,subscriptions}` and `outbox/{wiring,schema,writer,relay,maintenance}` separate the other message paths.        |
| `nest-jobs`      | `jobs/` groups queue definitions, job contracts, connection and configuration. `runtime/{nest,lifecycle,postgres,enqueue,scheduling,workers,dead-letter}` separates Nest providers from pg-boss operations. `provisioning/{schema,queues,transactions}` groups the migrator-only operations. `schema/` provides the schema identity and version shared by both roles.           |

- The transaction runner owns checkout, scope lifetime and commit or rollback. Its Drizzle
  adapter belongs to a single scope. The idempotency interceptor owns HTTP orchestration,
  while the idempotency store and maintenance code own persistence.
- The messaging connection owns its transport and readiness state. Stream administration owns
  JetStream start-up checks and provisioning. Rebuild subscriptions bound waiting messages at
  admission.
- The outbox relay owns publication scheduling and backoff. The batch publisher owns send and
  settlement order, the store owns SQL, and the retry policy classifies failures and computes
  retry delays. Automatic maintenance runs on its own schedule in bounded transactions with a
  database lock shared by replicas.
- The outbox writer and relay have independent entry points so they can run in different processes.
  The leased relay releases PostgreSQL between reservation and settlement. Use the
  [outbox migration and rollback guide](outbox-rollout.md) before enabling it.
- Jobs provisioning separates schema inspection, migration guards and runtime grants.
  `runtime/postgres/` owns role, schema and queue checks at startup. The runtime coordinates
  workers, active attempts, dead-letter monitoring and graceful shutdown.

Keep the declared public entry files as named export façades. Put implementation files in the
folder that owns their responsibility and give each production class its own file. Keep small
supporting types and functions with the behavior they serve and focused specs next to that behavior.
Add a subfolder when it separates a distinct responsibility with its own dependencies or tests.

## Boundaries

- No business logic, no knowledge of a specific service.
- No direct dependency on a service repository.
- Public API through explicit exports; breaking changes are majors with a deprecation first.

## Package checks and evolution

Build the kit and run `pnpm test:packaging` to check installed archives, TypeScript signatures
and runtime entry points. Exercise root imports with mandatory peers and exercise driver-specific
entry points with their optional peers installed. Keep architecture checks independent of containers.
Keep validation of transactions, redelivery and PostgreSQL roles in the integration suites.

`pnpm build` clears the generated package outputs with `rimraf` before compiling the TypeScript
project references. The archive tests compare the packed output inventory with the TypeScript
build configuration.

After Changesets publishes, the release workflow runs `pnpm test:packaging:published`. This
installs the exact registry tarballs in clean consumers and checks that Common and Messaging
load with their required peers. GitHub Packages can omit optional peer metadata when resolving
by name. The smoke test reports any such omissions and validates the peer metadata in the
installed tarballs.

Choose a new public entry point when an actual consumer needs to isolate a driver, an initialization
effect or an independently useful API. Keep the existing facade as a compatibility entry.
For a pg-boss upgrade, run the previous and candidate runtimes against the migrated schema. When
they cannot coexist, document and exercise the stop, provision, start and recovery sequence before
releasing. Record the supported toolchain versions exercised by the consumer checks.

## Capacity checks

Build the baseline and candidate with the same toolchain and run them on the same machine with the
same resources. Use `node tests/performance/outbox.mjs baseline <reference.json>` on the legacy
build, then `node tests/performance/outbox.mjs candidate <reference.json>` on the new build. The
benchmark uses three runs, disposable PostgreSQL, a 50 ms acknowledgement delay and an HTTP control
endpoint. Its gate requires at least 1.5 times the reference throughput and an HTTP p95 at most
10% above the reference. Use the service's real HTTP routes and its own pool telemetry for the
staging validation.

## Cross-repository changes

Each checkout owns its implementation and release. Use published `@cadenway/*` packages instead of sibling source imports or local dependency links. For contract changes, make the contract and generated package available first, then update the producing service, gateways and listeners, and finally the webapp. Each step should remain deployable independently.
