---
'@cadenway/nest-common': minor
---

Add the health indicators and the bootstrap helper.

- `HealthModule.forRoot({ indicators, timeoutMs })` and `forRootAsync`, with `postgresIndicator`, `redisIndicator` and `natsIndicator`. Readiness answers 503 with the Terminus body when a dependency is down or does not answer within 1 second; liveness never checks a dependency. The bare `HealthModule` import keeps its behavior: no indicator, 200.
- `createApplication(AppModule, options)`: logs, problem filter, validation pipe, route-name and entity-tag interceptors, internal token (when configured), JSON body limit, request deadline and shutdown hooks with telemetry flushed, so a service `main.ts` stays a few lines.
- `readPackageVersion`, from both the main and the `/telemetry` entry points.
