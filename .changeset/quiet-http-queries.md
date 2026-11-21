---
'@cadenway/nest-common': patch
---

Allow operators to remove HTTP query strings and free-form automatic HTTP error details from spans
exported over OTLP with `CADENWAY_OTEL_REDACT_HTTP_QUERY_STRINGS=true`.
