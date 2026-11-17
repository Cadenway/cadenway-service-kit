# @cadenway/nest-common

## 0.5.1

### Patch Changes

- a290617: Respect shutdown grace for durable deliveries and drain active manual outbox passes. Bound dead-letter advisory queues and validate lease prerequisites and runtime timer settings before starting work.
  
  Verify the Jobs database before activating pg-boss and keep nested transactions bound to their original pool and schema. Redact SQL and handler diagnostics and discard unused upstream authentication responses promptly.
  
  Clarify the runtime contracts in the published documentation comments and give production classes
  their own implementation files behind the existing public entry points.

## 0.5.0

### Minor Changes

- 83af938: Separate outbox writing, relay operations and PostgreSQL schema exports. The lease-based relay
  publishes outside its claim and settlement transactions after the owning service has expanded
  its outbox schema. Keep the existing outbox entry point available during the migration.
  Expose PostgreSQL deduplication through a consumer module that is independent of the writer.
  
  Separate Jobs runtime capabilities from provisioning and expose individual producer, worker
  and scheduler APIs. The existing Jobs entry point remains available during the migration.
  
  Separate PostgreSQL transaction execution from its public scope and runners, and expose pool
  wait and transaction duration through OpenTelemetry.

### Patch Changes

- 83af938: Group internal modules and their tests by responsibility while preserving the published entry points.
  
  - Give each PostgreSQL transaction its own Drizzle scope, enforce nested read-only requests, share in-flight readiness probes, bound HTTP error decoding, and separate idempotency storage from HTTP handling.
  - Preserve HTTP failure classification during response body cleanup.
  - Bound rebuild admission, dead-letter shutdown and outbox passes. Recover deleted durable consumers from retained events, prevent overlapping registrations and expired handler starts, and run outbox maintenance separately in coordinated batches.
  - Apply the Jobs grace period to individual attempts, observe visible dead-letter stock outside the startup path, and separate PostgreSQL startup checks and retention diagnostics from the runtime lifecycle.

## 0.4.3

### Patch Changes

- 54356a9: Separate request context from internal token guards and verification so the database entry point
  can read request identity without loading the guard.

## 0.4.2

### Patch Changes

- 4cfc7e8: A request body that is not valid JSON no longer exposes any part of itself.
  
  - The response changes, as a security and contract-conformance fix shipped in a patch: such a body now answers `400 request.invalid`, the code the contracts declare for a body that does not match its schema, with the fixed detail `The request body is not valid JSON.` and one `details.issues` entry (`in: body`, `path: ""`, `code: invalid_json`). It answered `400 http.bad-request`, a code no contract declares, with the text of `JSON.parse` as `detail`, which quotes the characters around the faulty token: on a sign-up, sign-in or verification body, part of a password. A client that matched `http.bad-request` for a malformed body must match `request.invalid`.
  - The JSON parser that `applyJsonBodyLimit` (and so `createApplication`) registers hands on that fixed problem instead of the parser error, which also held the whole body. The span the Express instrumentation opens around the parser records a `ProblemException` with the message `request.invalid: The request body is not valid JSON.`, and nothing of the body reaches the logs.
  - `ProblemFilter` and `toProblem` give the same response to the refusal of the JSON parser NestJS registers itself, in an application that does not call `applyJsonBodyLimit`; on that path the span of the parser still records its text.
  - Every other refusal of the body parser keeps its mapping: a body over the limit still answers `400 request.body-too-large`.
  - Migration note: `applyJsonBodyLimit` registers the parser of this package through `app.use` (a new optional member of `BodyParserHost`; a host without it gets `useBodyParser` as before). That parser does not keep the raw body, so an application created with `{ rawBody: true }` that calls `applyJsonBodyLimit` gets no `req.rawBody` on JSON requests. `createApplication` never enables `rawBody`, so services and gateways built with it see no difference.
  - The package now depends on `body-parser` directly, on the 2.x line Express 5 uses.

## 0.4.1

### Patch Changes

- ad754ff: Document consistently when the system transaction runner serves a request: the README and the `SystemTransactionRunner` docblock said both that it serves routes without an organization and that it must never serve the request of a user. They now say what the code does: a request that carries an organization goes through the tenant runner, a request without one (sign-up, sign-in, a route with an anonymous or system subject, a user acting outside any organization) is served in a system transaction, as the `Idempotency-Key` interceptor does. No behavior changes.

## 0.4.0

### Minor Changes

- 00e9d27: Follow-ups from wiring the two gateways on 0.3.0.
  
  - Validate the configuration once: `ConfigModule.forValue(config)` provides an already validated configuration under `CONFIG` without reading the environment, and `createApplication(AppModule, { config, provideConfig: true })` does it for the application module. `provideConfig` defaults to `false`; with `true`, `config` must be the complete result of `loadConfig`, and `createApplication` throws when it is missing.
  - The e-mail redaction of the logs now requires the last label of the domain to be letters, so a pnpm store path in a stack trace (`@cadenway+nest-common@0.3.0_zod@4.6.7`) is no longer masked. Addresses are masked as before.
  - The guidance on `HealthModule`'s `shutdownDelayMs` no longer assumes a proxy that probes readiness: Traefik's Docker provider follows container events, throttled to 2 seconds by default, and the gateways use 3000 ms.

## 0.3.0

### Minor Changes

- 66cc0c2: Follow-ups from wiring the first service (task-service) and the API and realtime gateways.
  
  Additions, each behind a new option or entry point; every existing default is unchanged:
  
  - `createApplication` accepts the application module as a class or as a `DynamicModule`.
  - `ConfigModule.forRoot({ schema, env, eager })`: `eager` defaults to `true` (validated in
    `forRoot`, as before). With `eager: false` the environment is read and validated when the
    application is created, so the application module can be imported statically and
    `createApplication` rejects with the `ConfigError`.
  - `DatabaseModule.forRootAsync({ imports, inject, useFactory })`: the providers of `forRoot` from
    options built at creation time, the `Idempotency-Key` interceptor included when they set
    `idempotency: true`. New type `DatabaseModuleAsyncOptions`.
  - `runApplication({ service, version }, main)`: a rejected start-up is written as one JSON line on
    the standard error, in the shape of the logs (`level: 'fatal'`, `msg: 'start-up failed'`, a
    sanitized `err`, the `issues` of a `ConfigError`), then the process exits with code 1. New types
    `RunApplicationOptions` and `StartupErrorStream`.
  - `setRequestOrganizationContext(request, context)`: the guard of an application that verifies its
    callers itself (a public gateway) gives a verified request its organization context; the
    handler, `InternalHttpClient`, the transaction runners and the logs read it as they read the
    internal token. It throws when the request already has a context or a verified internal token.
  - `HealthModule.forRoot({ shutdownDelayMs })`, default `0` (the stop is not slowed): how long the
    stop waits, readiness at 503, before the listener closes.
  - `HealthModule.forRootAsync({ imports })`, default `[]`, for injected providers that are not
    global.
  - Entry point `@cadenway/nest-common/register`, for
    `node --import @cadenway/nest-common/register --import ./dist/telemetry.js dist/main.js`, which
    instruments as the loader does without the `ExperimentalWarning`. `@cadenway/nest-common/hook.mjs`
    keeps working.
  - Entry point `@cadenway/nest-common/redis`: `ResilientRedisClient`, an ioredis client whose
    dropped command promises cannot stop the process, `createPubSubClients` and
    `pubSubClientOptions` for the connections of a pub/sub adapter, and `redisConfigShape`
    (`REDIS_URL`). `ioredis` (`^6.0.0`) is a new optional peer dependency, needed only by this entry
    point; the main entry point does not import it.
  - `ProblemFilter` handles WebSocket messages: the same problem as for HTTP, emitted to the client
    as the event `exception` (`WS_EXCEPTION_EVENT`); an unexpected error is logged. RPC errors are
    still thrown again.
  - The README documents a heap cap for the 256M containers (`--max-old-space-size=160`).
  
  Fixes, applied without an option because the previous behavior was a defect nobody can rely on:
  
  - Readiness answers 503 (`error.shutdown`, `shutting down`) as soon as the application starts
    shutting down, in every form of `HealthModule`, the bare class included; liveness keeps
    answering 200. It used to answer "ready" during the graceful stop.
  - `createApplication` no longer sends `X-Powered-By: Express`.
  - `createApplication` creates the application with `abortOnError: false` and without flushing the
    NestJS start-up lines when the creation fails: the error rejects the returned promise instead of
    being printed by the NestJS console logger and aborting the process, and an error thrown
    synchronously by a method of the application reaches its caller instead of exiting the process.
  - `OrganizationContextInterceptor` is registered by `createApplication` in every case, outermost
    of the shared interceptors (it does nothing for a request without identity), and opens the
    context once even when `InternalTokenModule` registers it too. The completion line of a request
    and the `Idempotency-Key` interceptor read the identity of the internal token or of the attached
    context.
  - `HealthModule` turns off the per-probe error line of Terminus and logs the changes of readiness
    instead: one `warn` (`readiness down`, naming the failing dependencies with `unreachable` or
    `timeout`) and one `info` (`readiness recovered`), nothing for repeated results.
  - `loadConfig` reports a variable that is not set and has no default as
    `<NAME>: required, not set`, instead of the type error of zod; a variable that is set keeps the
    message of zod. No value is ever echoed.
  
  Nothing to migrate. To adopt the additions: wrap `main.ts` in `runApplication`, switch the start
  command to `--import @cadenway/nest-common/register`, and set `shutdownDelayMs` above the probe
  interval of the proxy.

## 0.2.0

### Minor Changes

- 430c175: Add the typed configuration, the structured logs and the OpenTelemetry start-up.
  
  - Configuration: `loadConfig`, `ConfigModule.forRoot`, the `CONFIG` token, `ConfigError` and `baseConfigShape` (`NODE_ENV`, `PORT`, `LOG_LEVEL`, `LOG_PRETTY`), validated with zod at start-up.
  - Logs: `LoggingModule.forRoot` (through `nestjs-pino`) with the `service`, `version`, `traceId`, `spanId`, `requestId`, `route`, `status` and `durationMs` fields, default redaction of tokens, passwords, cookies, the `authorization` header and e-mail addresses, and the `X-Request-Id` handling. `Logger`, `PinoLogger` and `InjectPinoLogger` are re-exported.
  - Telemetry: `startTelemetry` in the new `@cadenway/nest-common/telemetry` entry point, `shutdownTelemetry`, `RouteNameInterceptor` and `nameHttpSpan`.
  - New `@cadenway/nest-common/hook.mjs` entry point. An application starts with `node --experimental-loader=@cadenway/nest-common/hook.mjs --import ./dist/telemetry.js dist/main.js`: `@opentelemetry/instrumentation/hook.mjs` cannot be resolved from an application under pnpm's strict `node_modules`.
  
  `HealthModule` is unchanged.
- 720a1b4: Add the `@cadenway/nest-common/database` entry point: transaction runners and `Idempotency-Key`.
  
  - `DatabaseModule.forRoot`: a `pg` pool of 5 connections by default, `TenantTransactionRunner` and `SystemTransactionRunner`. The tenant runner issues `SET LOCAL app.organization_id` from the organization context when a use case transaction starts; the system runner issues `SET LOCAL app.system_access` for work that crosses organizations.
  - `organizationPolicy()` and `organizationIsolation`: the row-level security policy every table with an `organization_id` declares.
  - `@Idempotent()`, `IdempotencyInterceptor` (option `idempotency: true`), the `idempotencyKeys` table and `purgeExpiredIdempotencyKeys`: the same key with another body answers 422, a request still running 409, and the response is replayed for 24 hours.
  - `databaseConfigShape` (`DATABASE_URL`).
  
  `drizzle-orm` and `pg` become optional peer dependencies, needed by this entry point only: nothing changes for a gateway without a database.
  
  For every service that enables idempotency: re-export `idempotencyKeys` from a `*.schema.ts` file, generate the migration, and add `ALTER TABLE "idempotency_keys" FORCE ROW LEVEL SECURITY;` to it.
- 3a58b5b: Add the health indicators and the bootstrap helper.
  
  - `HealthModule.forRoot({ indicators, timeoutMs })` and `forRootAsync`, with `postgresIndicator`, `redisIndicator` and `natsIndicator`. Readiness answers 503 with the Terminus body when a dependency is down or does not answer within 1 second; liveness never checks a dependency. The bare `HealthModule` import keeps its behavior: no indicator, 200.
  - `createApplication(AppModule, options)`: logs, problem filter, validation pipe, route-name and entity-tag interceptors, internal token (when configured), JSON body limit, request deadline and shutdown hooks with telemetry flushed, so a service `main.ts` stays a few lines.
  - `readPackageVersion`, from both the main and the `/telemetry` entry points.
- 824db6e: Add the HTTP formats shared by every route.
  
  - Errors: `ProblemException` and `ProblemFilter` answer `application/problem+json` (RFC 9457) with the `code` and `details` extensions; an unexpected error answers 500 `internal.unexpected` without any internal text.
  - Validation: `ZodValidationPipe` and `zodDto`; an unknown query parameter answers 400 `request.invalid`.
  - Pagination: `encodeCursor`, `decodeCursor`, `filterFingerprint`, `buildPage` and `pageQueryShape` (`limit` from 1 to 100, 50 by default).
  - Entity tags: `EtagInterceptor`, `@IfMatch()`, `assertVersionMatch`, `formatEtag` and `parseIfMatch`.
  - Body limit: `applyJsonBodyLimit` and `JSON_BODY_LIMIT_BYTES` (1 MB).
  
  Nothing is installed implicitly: an application registers the filter, the pipe and the interceptor itself until the bootstrap helper does it.
- 5493e1d: Add the internal HTTP client.
  
  - `InternalHttpClient`, on the native `fetch`: the internal token on every call, a deadline of 2 seconds at most taken from the time left to the current request, one retry of an idempotent call after a connection error or a 503, one circuit breaker per called service, and every failure thrown as an `application/problem+json` problem with a stable `upstream.*` code.
  - `requestDeadlineMiddleware`, `runWithDeadline`, `remainingBudgetMs` and the `X-Request-Timeout-Ms` header, which carries the time left from one backend to the next.
  
  Nothing is installed implicitly: an application builds its clients and registers the middleware.
- 2d64620: Add the internal token and the organization context.
  
  - `InternalTokenSigner` and `InternalTokenVerifier`: a JWT signed with `alg: Ed25519`, valid 60 seconds, with `aud` set to the called service and a `kid` header. Several issuers are trusted, each with its own keys; a key is accepted only for the issuer it is configured under.
  - `InternalTokenModule.forRoot({ verifier, signer })`, `InternalTokenGuard`, `@InternalAccess()` and `@SkipInternalToken()`. A route requires an organization and refuses an anonymous subject unless it declares otherwise.
  - `internalTokenVerifierConfigShape` and `internalTokenSignerConfigShape`: `INTERNAL_TOKEN_AUDIENCE`, `INTERNAL_TOKEN_TRUSTED_ISSUERS`, `INTERNAL_TOKEN_ISSUER` and `INTERNAL_TOKEN_PRIVATE_JWK`.
  - Organization context in an `AsyncLocalStorage`, derived from the verified token: `getOrganizationContext`, `requireOrganizationId`, `principalOf`, `runWithOrganizationContext` and `OrganizationContextInterceptor`.
  - Logs carry `organizationId` and `userId` inside an organization context.
  
  Nothing changes for an application that does not import `InternalTokenModule`. The health routes are exempt from the guard.
- d33e0c1: Address the security, reliability and API reviews of the unreleased additions.
  
  - Logs: SQL values never reach a line (the statement, parameters, `detail` and `where` of a database error are dropped); redacted keys are masked at any depth whatever their case and separators; e-mail addresses are masked inside logged objects too.
  - Transaction runners: a connection lost during a transaction no longer crashes the process; a `COMMIT` that PostgreSQL turns into a rollback throws `TransactionAbortedError`; the scope dies with its transaction; `tx.db` has no `transaction` method (type `TransactionDatabase`); joining a less strict transaction throws.
  - Internal HTTP client: a path outside the called service throws and redirects are refused; a timeout shortened by the request budget and a caller abort no longer count for the circuit breaker.
  - `createApplication`: `internalTokenVerification` defaults to `required` and throws without a verifier; `acceptIncomingRequestTimeout`; the telemetry flush runs after the application closed its resources, within 3 seconds.
  - Internal token: `organizationId` must be a UUID; `@InternalAccess` on a method is merged over the one on its class.
  - `Idempotency-Key`: the stored response belongs to the actor that obtained it; `@Idempotent({ isolationLevel })`.
  - Codes renamed before any release: `pagination.cursor-invalid`, `request.if-match-invalid`; a 412 is always `precondition.failed`.
  - `version` is optional for `LoggingModule` and `startTelemetry` and defaults to `readPackageVersion()`.
  - `@nestjs/platform-express` is declared as a peer dependency.
  - No longer exported, as nothing outside the package uses them: `createLoggerParams`, `resolveRequestId`, `filterFingerprint`, `getActiveTransaction`, and the third parameter of `runWithDeadline`.

## 0.1.2

### Patch Changes

- 851bd50: Document the health module and its liveness and readiness contracts.

## 0.1.1

### Patch Changes

- c45eb2b: Declare the third-party dependencies of the kit and add the `@cadenway/nest-jobs` package shell.
  
  - `nest-common`: `nestjs-pino`, `jose`, `cockatiel` and the OpenTelemetry SDK (traces and metrics over OTLP/HTTP); `zod` and `@opentelemetry/api` are peers.
  - `nest-messaging`: the NATS client (`@nats-io/transport-node`, `@nats-io/jetstream`); `drizzle-orm` and `pg` are optional peers, so a gateway without a database can consume events.
  - `nest-testing`: `testcontainers` with its PostgreSQL, NATS and Redis modules, and `msw`.
  - `nest-jobs`: `pg-boss`.
  
  No public API changes: the packages export what they exported before.

## 0.1.0

### Minor Changes

- b6799f3: Add `HealthModule`: `GET /health/live` and `GET /health/ready`, built on `@nestjs/terminus`. Readiness runs no dependency indicator yet.
