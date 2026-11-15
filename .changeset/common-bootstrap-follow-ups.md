---
'@cadenway/nest-common': minor
---

Follow-ups from wiring the first service (task-service) and the API and realtime gateways.

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
