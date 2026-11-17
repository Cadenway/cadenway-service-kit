---
name: cw-logging-and-tracing
description: "Change Cadenway backend logging, redaction, tracing, metrics or OpenTelemetry start-up."
---

# Logging and tracing

All of it comes from `@cadenway/nest-common`. An application never configures pino or the
OpenTelemetry SDK itself.

Read the matching sections of the local integration guide before editing.

- [Logs](../../../docs/integration.md#logs) for log fields, redaction and levels.
- [Traces](../../../docs/integration.md#traces) for propagation, start-up, route spans and export.
  For instrumentation changes, also read
  [Not installed, on purpose](../../../docs/integration.md#not-installed-on-purpose).
- [Metrics](../../../docs/integration.md#metrics) for route, messaging and runtime measurements.
