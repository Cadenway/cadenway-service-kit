---
'@cadenway/nest-common': patch
---

Remove HTTP query strings and URL fragments from exported traces by default, including Node HTTP
and fetch spans. Retain route templates, trace propagation and the configured private path
redaction.
