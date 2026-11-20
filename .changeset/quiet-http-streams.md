---
'@cadenway/nest-common': minor
---

Add an optional total streaming deadline to the internal HTTP client. Streaming calls keep the ordinary header timeout, forward their bounded remaining deadline and preserve caller cancellation while reading the body. All existing calls keep their current timeout.
