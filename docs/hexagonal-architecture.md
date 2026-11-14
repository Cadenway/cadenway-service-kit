# Hexagonal architecture for Cadenway NestJS services

Business modules own rules and data. A module's application can run in a unit test with plain TypeScript and test doubles. NestJS assembles the module, HTTP and message consumers drive it, and adapters connect it to the service's database, search index or external systems.

## Module layout

Create the folders a capability uses. A read-only capability can return a projection from a read port. Add domain objects when the capability owns invariants or state transitions.

```text
src/
  app.module.ts
  modules/
    tasks/
      MODULE.md
      tasks.module.ts
      domain/
        task.ts
        task.spec.ts
      application/
        commands/
          change-task-status.ts
          change-task-status.spec.ts
        ports/
          task-unit-of-work.port.ts
      api/
        http/
          tasks.controller.ts
          tasks.controller.spec.ts
        messaging/                  # incoming event and job handlers
      infrastructure/
        persistence/
          task.schema.ts
          drizzle-task.repository.ts
          drizzle-task.repository.int-spec.ts
        messaging/                  # wire event mapping and outbox adapter
test/
  change-task-status.int-spec.ts
```

Use kebab-case for directories and file stems. Use `<module>.module.ts` for composition, `.controller.ts` for HTTP controllers, `.handler.ts` for incoming consumers, `.port.ts` for outbound interfaces, and `.repository.ts` and `.schema.ts` for persistence. Name a use case by its intent (`change-task-status.ts`, `ChangeTaskStatus`).

## Dependencies and responsibilities

| Area                 | Responsibility                                                                                                                                                                             | Allowed dependencies inside the module                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `domain/`            | Entities, value objects, invariants, domain errors and domain events. Pass time and IDs in explicitly.                                                                                     | Domain only.                                                                  |
| `application/`       | Commands, queries, their inputs and outputs, and outbound ports. A use case signature is its inbound port.                                                                                 | Application and domain.                                                       |
| `api/`               | HTTP, broker and job entry points. Validate contracts, translate authenticated context and inputs, call a use case and map the outcome to the protocol.                                    | API and application entry points.                                             |
| `infrastructure/`    | Implement outbound ports. Map persistence, network and broker representations to and from application or domain types.                                                                     | Infrastructure, domain and application ports.                                 |
| `<module>.module.ts` | Composition root. Register controllers and consumers, bind interfaces with symbol tokens, instantiate plain TypeScript use cases with Nest `useFactory`, and export approved entry points. | The module's layers and explicitly exported entry points of imported modules. |

Keep Nest, the ORM, generated wire DTOs, transport exceptions, environment and network access at the edges. A controller may use the common authentication and error adapters. Keep transport validation and DTO mapping there, and business authorization and state rules inside the owning module. Scope data access by the organization taken from verified context. The payload cannot override it.

Cross-module imports use only the entry and consumer declared by the owning module in `MODULE.md`. Bind another module's exported use case behind an outbound port when orchestration requires it. Cross-service dependencies use released `@cadenway/contracts` and generated clients or published events. Each service owns its database, tables and migrations. Use the service kit for common authentication, observability, messaging and durable jobs.

Gateway handlers and technical capabilities follow the same direction at their real boundaries. HTTP and WebSocket handlers drive application orchestration, and generated clients, Redis and NATS implementations sit behind ports where they are used. Keep routing, verification, aggregation, presence and fan-out in the gateway that owns them. Business invariants and persistent business data belong to the producing services. The service kit contains technical packages with declared exports and package dependencies.

## Example: changing a task status

1. The HTTP adapter validates the published route contract and derives the organization and actor from verified context. It maps the request to `ChangeTaskStatus`.
2. The use case calls its `TaskUnitOfWork` port. The callback receives a task repository and outbox writer bound to one transaction. Load by organization and task ID, then call the task's transition method.
3. If the task accepts the transition, persist it and append the mapped domain event to the outbox before committing. A failure rolls back both writes. An outbox relay publishes after commit. External HTTP calls are performed outside the transaction.
4. An incoming event handler validates the envelope and passes the event ID to its use case. Record deduplication and transactional effects atomically. Acknowledge after a successful commit and make retries safe for effects outside the database through an idempotency key or durable handoff.

## Tests and architecture gate

- Colocate `<subject>.spec.ts` with the source for domain rules, use cases with fake ports and HTTP or message mapping. Tests of adapter behavior with real disposable dependencies use `<subject>.int-spec.ts` beside the adapter. Use root `test/` for cross-layer `.int-spec.ts` scenarios.
- Check invalid transitions, tenant isolation, rollback of both the task and outbox, and repeat delivery without duplicate effects when implementing the first corresponding capability. Use actual disposable dependencies for integration tests when available from `@cadenway/nest-testing`.
- Run `pnpm test:architecture` alongside ESLint and behavior tests. The check parses authored TypeScript, resolves each repository's actual TypeScript config and reports import, cycle, structure and naming findings. It runs without Nest or containers. Behavioral guarantees such as transaction atomicity and authorization still need behavioral tests.

## Consumer rollout

The architecture suite in each service and gateway imports `@cadenway/nest-testing/architecture`. Once a version exposing that entry is available through the normal Changesets release, update the development dependency with pnpm in each checkout and commit the resulting lockfile. Run `pnpm install --frozen-lockfile` and `pnpm test:architecture`. Add that command to `pnpm quality` and to the CI quality job in the same change as the dependency update. Each checkout can adopt the release independently.

## MODULE.md template

Replace the sample names and state `None` for sections without entries. Keep the `Public entry points` table machine-readable. Paths are relative to the owning module, without the `.ts` extension, and consumers are module directory names. Document request and event contracts in their authoritative specifications.

```md
# Tasks

## Purpose

Describe the capability, what the module owns, and what belongs elsewhere.

## Public entry points

| Entry point                          | Consumers |
| ------------------------------------ | --------- |
| application/queries/get-task-summary | reporting |

## Owned tables

List owned tables and organization scoping.

## API

List internal routes and their published contract owners.

## Events emitted

List published events and their transactional boundaries.

## Events consumed

List subscriptions and deduplication behavior.

## Invariants

State the business rules and authorization assumptions.

## Transactions

State the unit of work and which effects commit together.

## Decisions

Link decisions and record any reviewed architecture exceptions.
```
