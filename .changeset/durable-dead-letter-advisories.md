---
'@cadenway/nest-messaging': minor
---

Support an opt-in JetStream inbox for terminal advisories. The worker replays advisories after
restart, retries copies before acknowledgement, and records a metadata-only marker if the source
message has expired or the source stream has been replaced.
