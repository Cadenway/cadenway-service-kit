# Hexagonal architecture for Cadenway NestJS services and gateways

Cadenway uses two architecture profiles. The `service` profile gives a business capability ownership of its rules, data and transactions. The `gateway` profile gives a technical capability ownership of routing, request aggregation, access checks or realtime delivery. Both profiles put capabilities under `src/modules/<module>/` and use presentation adapters, application use cases, outbound ports and explicit Nest composition.

This is the target for `convention: 'strict'`. A repository can prepare for the target while it still runs the existing checks. See [Consumer rollout](#consumer-rollout) for the activation sequence.

## Service profile

A module lives under `src/modules/<module>/`. An `<area>` groups a stable part of the capability, such as `lifecycle`, `assignment` or `comments`. An `<operation>` describes one intent, such as `change-task-status`. A `<concern>` groups related outbound dependencies, such as persistence, transactions or messaging. Create directories when their first file needs them. A query may simply return a projection through a read port.

```text
src/
  main.ts
  app.module.ts
  config/
  infrastructure/                                # technical adapters shared by this service
  telemetry.ts
  migrate.ts
  modules/<module>/
    MODULE.md
    <module>.module.ts
    public/<area>/<operation>.ts
    domain/
      aggregates/<aggregate>/
      value-objects/<concept>/
      {policies,events,errors}/<area>/
    application/
      use-cases/
        commands/lifecycle/change-task-status/
          change-task-status.use-case.ts
          change-task-status.input.ts
          change-task-status.output.ts
          change-task-status.use-case.spec.ts
        queries/<area>/<operation>/
      {models,projections,mappers,services}/<area>/
      ports/outbound/<concern>/<area>/
    presentation/
      http/controllers/<resource>/
      http/dto/{input,output}/<resource>/
      http/{mappers,validation,errors,guards}/<resource>/
      http/webhooks/<provider>/
      messaging/handlers/<event-family>/
      jobs/handlers/<job-family>/
      websocket/gateways/<channel>/
      cli/commands/<area>/
    infrastructure/
      persistence/drizzle/{schemas,mappers,repositories,transactions}/<area>/
      messaging/{outbox,rebuild}/<area>/
      jobs/pg-boss/<area>/
      adapters/<integration>/
    composition/                                  # optional NestJS wiring
      tokens/<area>/
      providers/{use-cases,adapters}/<area>/
test/
  change-task-status.int-spec.ts
```

Use kebab-case. File suffixes identify roles, such as `.use-case.ts`, `.input.ts`, `.output.ts`, `.port.ts`, `.controller.ts`, `.dto.ts`, `.handler.ts`, `.gateway.ts`, `.provider.ts`, `.token.ts`, `.schema.ts`, `.repository.ts` and `.mapper.ts`. Give each named exported contract its own file. Private types can stay with their implementation. Keep inputs and outputs beside their use case when they are specific to it. A reusable application model belongs under its own area.

| Layer             | Responsibility                                                                                                                                               | Dependencies within the module                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `domain/`         | Apply business rules and model invariants, including the events and errors they produce.                                                                     | Domain.                                       |
| `application/`    | Authorize and orchestrate operations, choose a transaction boundary, invoke ports and map application results. `execute` is the use case's inbound contract. | Application and domain.                       |
| `presentation/`   | Validate the incoming protocol and verified context, call the use case and map the outcome back to the protocol.                                             | Presentation and application entry points.    |
| `infrastructure/` | Implement outbound ports and map SQL, HTTP, broker or provider representations at that boundary.                                                             | Infrastructure, domain and application ports. |

Keep Nest, Drizzle, generated wire DTOs, transport exceptions, provider SDKs, environment access and network clients at the edges. For HTTP, use `zodDto` with the generated validators and map the result to the application input. The unit of work constructs transaction-bound repositories from the current transaction.

### NestJS wiring

`<module>.module.ts` is the composition root. Keep small sets of provider declarations, factories and symbol tokens directly in that file. `composition/` is an optional NestJS wiring directory alongside the four layers. Use `composition/providers/` and `composition/tokens/` when splitting out wiring makes the module easier to read. The strict verifier accepts both layouts.

The composition root can reference the module's layers and the declared public boundaries of other modules. Domain and application stay independent of NestJS. Use factories to construct plain TypeScript use cases and symbol tokens for separately injected ports. Register HTTP controllers in `controllers` and handlers and WebSocket gateways in `providers`.

Service-wide configuration, connections, clocks, health and observability are technical concerns. Share reusable Nest mechanisms through the service kit. Keep business rules in their owning capability and use a port when they need technical services. PostgreSQL tables and migrations belong to one service. Use the [database runner and row-level security guidance](../packages/nest-common/README.md#transaction-runners) at the persistence boundary. Use the organization from verified request or event context when working in a tenant transaction. Work without an organization or across organizations uses an explicit system transaction where the owning module permits it.

### Public module boundaries

Declare consumers in the owner's [module manifest](#modulemd-template). The adapter for a consuming module uses a port owned by that consumer. It maps to the owner's explicitly permitted operation, whose file under `public/<area>/<operation>.ts` exports one local use case class by name. The public file can export named input and output types from that operation and named models or projections from the owning application. In the owner's Nest module, put the same use case in `exports`. Only the consuming module's NestJS wiring can import another module's declared wiring entry. Cross-service calls use released `@cadenway/contracts` and the generated client or a published event.

Named types reachable from `execute` parameters and results, including nested properties and generic arguments, must be public when they originate in a module. The rule applies to re-exports and aliases. Keep repositories, transaction types, private domain models and outbound ports inside the owning module. Constructor dependencies are part of composition. For example, the Accounts adapter can call the Sessions operation behind its own `SessionOpener` port. Compatible nested transaction runners join the same transaction, preserving the sign-in rollback guarantee.

### Time and IDs

- **Time** is passed in explicitly. The application gets the instant from the clock port and supplies it to the domain method. Supply an explicit time zone when calculating recurring local schedules.
- **IDs are assigned by PostgreSQL**, with `uuidv7()` as the column default. A repository inserts a new aggregate and reads back its ID with `RETURNING`. The use case builds the event and its outbox row from that stored value in the same transaction.
- An existing aggregate receives its ID when loaded. Display keys such as `CAD-482` are separate business values allocated by the owning module.

## Gateway profile

Gateway capabilities live under `src/modules/<module>/` and follow the same [NestJS wiring rules](#nestjs-wiring) as services. Each capability owns a `MODULE.md` and a `<module>.module.ts`. A gateway applies technical policy, such as scopes, rate limits and access checks. The services own business invariants and persistent business data. Gateways use Redis for technical state such as counters and presence. The gateway profile excludes a business domain, PostgreSQL schemas, business repositories and a transactional outbox.

Every route, guard that orchestrates a capability, WebSocket entry point and event handler invokes an application use case. This includes a route that forwards a single request. The use case invokes its own outbound port, and composition binds the port to an infrastructure adapter. Presentation imports the use case and its input and output types. Outbound port types, adapter implementations and their injection tokens stay outside presentation.

Gateway modules follow the [public module rules](#public-module-boundaries). A gateway module can also publish a named, decorated guard from `presentation/http/guards/<area>/<name>.guard.ts` through `public/<area>/<name>-guard.ts`. List the presentation consumers in `MODULE.md` and export the guard provider from the owning Nest module. A consuming module imports the declared entry from presentation and the module wiring from composition. For example, `auth` can publish a guard for `me`. The public guard rule is specific to gateways.

Use the module directory name as the owner ID. For example, `auth` owns guard behavior and `auth-routes` owns the public authentication endpoints. A module's URL prefix does not determine its owner. Bootstrap, configuration, health, shared clients and shared Redis are technical wiring at the repository root. The API Gateway also keeps shared problem formatting in `src/problems/` and shared HTTP mappers, middleware and session transport helpers under `src/presentation/http/{mappers,middleware,session}/`. These root concerns stay independent of the individual modules' private ports, tokens and transport classes. Within a module, only presentation and composition use the shared HTTP helpers. An unknown layer under a module root is a violation.

### API Gateway profile

```text
src/
  app.module.ts
  problems/
  presentation/http/{mappers,middleware,session}/
  clients/
    clients.module.ts
    <service>.client.ts
    generated/
  modules/
    auth/
      MODULE.md
      auth.module.ts
      public/<area>/<name>-guard.ts
      presentation/http/guards/<area>/
      application/use-cases/queries/<area>/verify-session/
      application/ports/outbound/<concern>/<area>/
      infrastructure/adapters/<service>/
      composition/{tokens,providers}/              # optional NestJS wiring
    auth-routes/
      MODULE.md
      auth-routes.module.ts
      presentation/http/{controllers,mappers}/<resource>/
      presentation/http/dto/{input,output}/<resource>/
      application/use-cases/{commands,queries}/<area>/<operation>/
      application/ports/outbound/<concern>/<area>/
      infrastructure/adapters/<service>/
      composition/{tokens,providers}/              # optional NestJS wiring
    me/
      MODULE.md
      me.module.ts
      presentation/http/controllers/<resource>/
      application/use-cases/queries/<area>/<operation>/
      application/ports/outbound/<concern>/<area>/
      infrastructure/adapters/<service>/
      composition/{tokens,providers}/              # optional NestJS wiring
    task-detail/                                  # when aggregation is implemented
      MODULE.md
      task-detail.module.ts
      presentation/http/controllers/<resource>/
      application/use-cases/queries/<area>/<operation>/
      application/ports/outbound/<concern>/<area>/
      infrastructure/adapters/<service>/
      composition/{tokens,providers}/              # optional NestJS wiring
```

`auth` owns guard orchestration, including `VerifySession`. `auth-routes` owns the public authentication endpoints. `me` owns the current-user endpoint. Add future aggregations, rate-limit policies and public flows as named modules when they have an implemented capability. A future webhook relay belongs to its owning named module under `presentation/http/webhooks/<provider>/`.

`ClientsModule` exports shared technical clients. Those clients invoke `src/clients/generated/` and work with wire types. Each consuming module imports `ClientsModule` for composition, adapts the technical client to a module-owned port and maps wire values at the adapter. An HTTP controller maps its request and response and invokes only the local application use case. Keep aggregation, deadline behavior and permitted partial results in the appropriate application use case and shared technical client.

### Realtime Gateway profile

```text
src/
  app.module.ts
  infrastructure/redis/
  modules/
    connection/
      MODULE.md
      connection.module.ts
      presentation/websocket/gateways/<channel>/
      application/use-cases/{commands,queries}/<area>/<operation>/
      application/ports/outbound/<concern>/<area>/
      infrastructure/adapters/<integration>/
      composition/{tokens,providers}/              # optional NestJS wiring
    <event-family>-relay/                         # when the relay is implemented
      MODULE.md
      <event-family>-relay.module.ts
      presentation/messaging/handlers/<event-family>/
      application/use-cases/commands/<area>/<operation>/
      application/ports/outbound/<concern>/<area>/
      infrastructure/adapters/<integration>/
      composition/{tokens,providers}/              # optional NestJS wiring
    presence/                                     # when presence is implemented
      MODULE.md
      presence.module.ts
      application/use-cases/{commands,queries}/<area>/<operation>/
      application/ports/outbound/<concern>/<area>/
      infrastructure/adapters/redis/
      composition/{tokens,providers}/              # optional NestJS wiring
```

`connection` owns the Socket.IO entry point and its connection policy. The application authorizes room membership before the transport joins the socket. A future relay family has a named module of its own. Its handler validates the event, and its use case chooses the scope of delivery. The presence capability owns its ports and any adapter that implements them. Bootstrap initializes the shared Redis connection and Socket.IO adapter.

## Worked examples

These examples describe the target layout and control flow. The owning repository still determines which routes, events and integration capabilities are available through its released contracts.

### HTTP command with an outbox

1. A controller in `presentation/http/controllers/tasks/` validates the request and maps verified organization and actor information to `ChangeTaskStatus`.
2. The use case in `application/use-cases/commands/lifecycle/change-task-status/` calls its `TaskUnitOfWork` port. The adapter in `infrastructure/persistence/drizzle/transactions/tasks/` uses the tenant runner. Its callback receives a task repository and outbox writer tied to that transaction.
3. Load by organization and task ID, apply the transition, persist the updated task and append the event. A rejected transaction rolls both writes back. The relay publishes after commit. Perform external HTTP operations outside that transaction.

### Durable event, job and SMTP

1. An event handler in `presentation/messaging/handlers/<event-family>/` validates the AsyncAPI-backed envelope and passes the event ID to its use case. With the kit deduplicator, record the receipt and local changes atomically. JetStream is acknowledged after commit. Follow the kit's redaction policy for restricted events and their dead letters.
2. Enqueue work through the queue port and its `infrastructure/jobs/pg-boss/` adapter in that transaction. Use an occurrence key that identifies the intended job. The worker in `presentation/jobs/handlers/<job-family>/` runs after the enqueue commits.
3. The worker calls separate template renderer and SMTP ports behind the Handlebars and Nodemailer adapters. Send outside the database transaction and store the result. The occurrence key deduplicates enqueue. It cannot eliminate repeated SMTP delivery if the process stops after sending and before recording completion. Document retries and dead letters.

See [consuming events](../packages/nest-messaging/README.md#consuming) and [enqueuing jobs](../packages/nest-jobs/README.md#enqueue-in-the-use-case-transaction).

### Signed webhook

1. Route Stripe, GitHub or GitLab traffic through `presentation/http/webhooks/<provider>/`. When relaying, preserve the raw body and provider signature headers.
2. At the owning service, verify the signature against those bytes before making any change. An outbound verification adapter wraps the provider SDK and maps the verified result to application values.
3. Deduplicate the provider delivery in the owning service. Perform the local state change or enqueue lasting work. Outbound integration webhooks also use durable jobs.

### Search rebuild

1. Separate the query port and the indexing port. Handle durable change events through the ordinary subscriber and map search documents at the Meilisearch adapter.
2. Rebuild a separate index using records re-emitted by the source owners. Treat reconstruction messages as best effort in the default NATS rebuild mode. A successful publish or flush does not demonstrate receipt or indexing. Make repeated records safe and allow reconstruction to restart.
3. Keep the current index active until completeness is verifiable against the sources, the required index operations have finished successfully and changes during reconstruction are accounted for. When the available protocol cannot establish completeness, report the incomplete rebuild and keep the current index active.

See [the rebuild transport](../packages/nest-messaging/README.md#rebuild).

### HTTP mirror and aggregate

The current-user controller in `src/modules/me/presentation/http/controllers/` calls its local application query. The query reads through its own port. The `me` adapter implements that port with a shared technical client and maps the response from the internal contract. A mirror keeps this boundary even when it makes one upstream request.

The future task-detail controller calls a query in `src/modules/task-detail/application/use-cases/queries/`. That query issues independent reads concurrently through module-owned ports. The adapters use the internal client's request deadline. A required source failure fails the request. A secondary failure produces a partial result only when the public contract authorizes it. The controller maps the final result to the public DTO.

### Realtime relay

When room joining is implemented, the gateway in `src/modules/connection/presentation/websocket/gateways/` validates the handshake and calls the application use case to check organization membership and object access before joining. When a relay is implemented, its own module's NATS handler maps a validated event to a use case input. Application selects the recipients in scope, and the Redis-backed Socket.IO adapter sends to those rooms. The shared Socket.IO server and its Redis fan-out adapter are part of the technical bootstrap.

### Other boundaries

- Identity callbacks and credentials use HTTP DTOs in presentation. OIDC, SAML, WebAuthn and OTP implementations sit behind ports. Identity owns proof and session rules.
- S3 adapters handle URL signing and object inspection for Garage or OVH. The use case validates metadata and finalization after direct object transfer. Keep the internal storage address and the browser-facing signed address distinct.
- Query selected authorized rows in application, then serialize CSV in presentation. A CLI command drives the same application operations. Cron and recurring local schedules supply explicit times and time zones.
- Keep migration and OpenTelemetry bootstrap at the technical entry points. When schemas move into the layered layout, update Drizzle's discovery globs. When Nest assets move, update their copy and runtime paths, including email templates.

## Tests and architecture gate

Use `verifyNestArchitecture` from `@cadenway/nest-testing/architecture` in `pnpm test:architecture` with the project's `tsconfig` and the `service` or `gateway` profile. Opt into v2 with `convention: 'strict'`. The existing convention still applies when this option is absent. In strict mode every finding fails the architecture test, including findings in legacy code. Exceptions cannot suppress findings in this mode.

The verifier checks authored paths, ownership, naming, dependency direction, SDK placement, import aliases, named re-exports, public consumers and eager cycles. It can check declared Nest exports and the application types that a public operation exposes. It runs without booting Nest or opening connections. A startup test verifies that Nest resolves the providers and activates the adapters. A behavior test verifies authorization, isolation, rollback, retries and other runtime guarantees.

Colocate a `<subject>.spec.ts` with its domain, use case or adapter source. Put an adapter test with a disposable real dependency in `<subject>.int-spec.ts` beside the adapter. Place cross-layer `.int-spec.ts` scenarios in the repository's `test/` directory. Include coverage of invalid transitions, cross-organization access, a rollback that leaves neither business writes nor an outbox row, and redelivery without duplicate local effects where applicable.

## Consumer rollout

Release the verifier through Changesets in `cadenway-tooling`. Each adopting checkout updates its published `@cadenway/nest-testing` development dependency with pnpm and commits its resulting lockfile. Keep `pnpm test:architecture` in `pnpm quality` and CI. Enable `convention: 'strict'` first in Identity and Notification, then in the remaining services and the two gateways.

Publish the guide and checker before activation. An activation can merge once its repository passes strict. Record any required source changes separately from the guide and checker. Check the migration glob, asset paths and startup tests as part of a later source relocation.

## MODULE.md template

Replace the sample names and write `None` for sections without entries. Keep `Public entry points` as a machine-readable table. Paths are relative to the owning module and omit `.ts`. List consumers by their module directory names, separated by commas. A gateway may use an owner ID such as `me` or `auth-routes`. Declare a wiring file separately when another module needs to import it. Document request and event contracts in their owning specifications.

```md
# Tasks

## Purpose

Describe the capability, what it owns and what belongs elsewhere.

## Public entry points

| Entry point                       | Consumers |
| --------------------------------- | --------- |
| public/lifecycle/get-task-summary | reporting |
| tasks.module                      | reporting |

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

Link decisions and record migration dependencies or follow-up changes.
```
