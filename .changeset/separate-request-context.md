---
'@cadenway/nest-common': patch
---

Separate request context from internal token guards and verification so the database entry point
can read request identity without loading the guard.
