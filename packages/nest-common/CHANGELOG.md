# @cadenway/nest-common

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
