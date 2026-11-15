---
'@cadenway/nest-messaging': patch
---

`manageStreams` creates `EVENTS_RESTRICTED` with a maximum age of one hour, as cadenway-ops now does, instead of seven days: its messages carry a single-use code or link. The retention (limits, oldest dropped first), the file storage and the byte cap (`restrictedMaxBytes`, 64 MiB) are unchanged, and so is `EVENTS`. With `manageStreams` on, an existing restricted stream is updated to one hour at the next start; `manageStreams` stays off outside local tests, where cadenway-ops owns the streams.
