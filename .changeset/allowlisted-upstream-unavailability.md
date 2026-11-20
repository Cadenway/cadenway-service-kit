---
'@cadenway/nest-common': minor
---

Allow internal HTTP clients to opt in to preserving specific, documented 503 problem codes from a
called service. The default still discards server error bodies. Preserved codes use local problem
details and the same retry and circuit-breaker rules as other 503 responses.
