---
'@cadenway/nest-common': minor
---

Add the typed configuration, the structured logs and the OpenTelemetry start-up.

- Configuration: `loadConfig`, `ConfigModule.forRoot`, the `CONFIG` token, `ConfigError` and `baseConfigShape` (`NODE_ENV`, `PORT`, `LOG_LEVEL`, `LOG_PRETTY`), validated with zod at start-up.
- Logs: `LoggingModule.forRoot` (through `nestjs-pino`) with the `service`, `version`, `traceId`, `spanId`, `requestId`, `route`, `status` and `durationMs` fields, default redaction of tokens, passwords, cookies, the `authorization` header and e-mail addresses, and the `X-Request-Id` handling. `Logger`, `PinoLogger` and `InjectPinoLogger` are re-exported.
- Telemetry: `startTelemetry` in the new `@cadenway/nest-common/telemetry` entry point, `shutdownTelemetry`, `RouteNameInterceptor` and `nameHttpSpan`.
- New `@cadenway/nest-common/hook.mjs` entry point. An application starts with `node --experimental-loader=@cadenway/nest-common/hook.mjs --import ./dist/telemetry.js dist/main.js`: `@opentelemetry/instrumentation/hook.mjs` cannot be resolved from an application under pnpm's strict `node_modules`.

`HealthModule` is unchanged.
