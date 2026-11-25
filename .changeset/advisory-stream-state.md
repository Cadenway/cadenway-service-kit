---
'@cadenway/nest-messaging': minor
---

Expose the terminal consumer advisory stream state as clear, held, or unknown, with the latch's
last sequence and creation time, so a service can tell that an advisory was recorded since it
certified its state, even once the advisory is purged.
