---
'@cadenway/nest-common': minor
---

Add the opt-in `redactRedisCommandArguments` telemetry option. It preserves Redis operation
names and trace context while omitting command arguments and free-form Redis and automatic HTTP
trace error details.
