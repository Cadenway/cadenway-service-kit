---
'@cadenway/nest-common': minor
---

Follow-ups from wiring the two gateways on 0.3.0.

- Validate the configuration once: `ConfigModule.forValue(config)` provides an already validated configuration under `CONFIG` without reading the environment, and `createApplication(AppModule, { config, provideConfig: true })` does it for the application module. `provideConfig` defaults to `false`; with `true`, `config` must be the complete result of `loadConfig`, and `createApplication` throws when it is missing.
- The e-mail redaction of the logs now requires the last label of the domain to be letters, so a pnpm store path in a stack trace (`@cadenway+nest-common@0.3.0_zod@4.6.7`) is no longer masked. Addresses are masked as before.
- The guidance on `HealthModule`'s `shutdownDelayMs` no longer assumes a proxy that probes readiness: Traefik's Docker provider follows container events, throttled to 2 seconds by default, and the gateways use 3000 ms.
