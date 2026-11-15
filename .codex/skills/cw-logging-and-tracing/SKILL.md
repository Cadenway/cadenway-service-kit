---
name: cw-logging-and-tracing
description: "The log fields, redaction, trace propagation, metrics and OpenTelemetry start-up shared by every Cadenway backend. Load it before touching logging, tracing or metrics."
---

# Logging and tracing

All of it comes from `@cadenway/nest-common`. An application never configures pino or the
OpenTelemetry SDK itself.

## Logs

| Concern | Rule |
| --- | --- |
| Format | One JSON line per event, through `nestjs-pino` |
| Fields | `service`, `version`, `traceId`, `spanId`, `organizationId`, `userId`, `route`, `status`, `durationMs`, the request id |
| Redaction | Tokens, passwords, cookies, the `authorization` header and e-mail addresses are masked by default; no e-mail address or IP at `info` |
| Never logged | Request bodies, SQL values, query strings |
| Level | `LOG_LEVEL`; `pino-pretty` is a development transport, never a production one |

## Traces

| Concern | Rule |
| --- | --- |
| Propagation | `traceparent` (W3C) in HTTP headers and in NATS message headers |
| Start-up | `NODE_OPTIONS="--max-old-space-size=160" node --import @cadenway/nest-common/register --import ./telemetry.js main.js`: the hooks registered with `module.register()` instrument an ESM application, and NestJS 12 imports Express as ESM. The kit entry point resolves `@opentelemetry/instrumentation/hook.mjs`, which an application cannot resolve itself under pnpm; `--experimental-loader=@cadenway/nest-common/hook.mjs` still works but prints an `ExperimentalWarning` at every start. The heap cap is about 60 % of a 256M container |
| Instrumentations | HTTP, Express, pg, ioredis and undici, listed one by one |
| Route name | An interceptor names the span and sets `http.route`: no OpenTelemetry instrumentation supports NestJS 12 |
| Export | OTLP over HTTP to `OTEL_EXPORTER_OTLP_ENDPOINT`; nothing leaves the process when the variable is unset |

## Metrics

| Scope | Measured |
| --- | --- |
| Each route | Rate, errors, duration |
| Messaging | Outbox lag, consumer lag; an alert fires past 24 hours |
| Runtime | PostgreSQL pool use, event-loop delay |

## Not installed, on purpose

- `@opentelemetry/instrumentation-nestjs-core`: its supported range stops before NestJS 12.
- `@opentelemetry/instrumentation-router`: it duplicates the spans of Express 5.
