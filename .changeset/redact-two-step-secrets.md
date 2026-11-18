---
'@cadenway/nest-common': patch
---

Mask the secrets of two-step verification (contracts 0.8.0) in the logs by default.
`DEFAULT_REDACTED_KEYS` gains `trustedDeviceToken`, `otpauthUri`, `code`, `codes`, `backupCodes` and
`credential` (the WebAuthn answers), and the cookie names `__Host-cw_session` and
`__Host-cw_trusted_device`, which mask a parsed cookie map; the `cookie` and `set-cookie` headers
were already masked whole. Every existing key stays. Like the other keys, the new ones match at any
depth and whatever their case and separators.

This changes a default without an option, a deliberate security exception to "default unchanged",
released as a patch like the earlier tightenings of the redaction; no exported declaration changes.
`redactKeys` only adds keys, so a service cannot unmask the new ones.

The `code` of an error logged under `err`, and of the errors serialized inside it (`Error`-valued
members and `aggregateErrors`), is its machine code (a SQLSTATE, `ECONNREFUSED`, `ERR_JWT_EXPIRED`)
and stays readable, even when `redactKeys` names `code`. Every other `code` is now `[REDACTED]`,
whether a string or a number. Lines that change:

- an error line carrying a `ProblemException`: `err.problem.code`, `err.response.code` and the
  `code` of its `details.issues` (the message still starts with the problem code);
- the `issues[].code` that `@cadenway/nest-messaging` logs for an event that does not match its
  contract (the `path` stays);
- a plain object logged under `err`, or any logged object, with a `code` member, such as a JetStream
  `api_error`.

Migration: a service that logs a machine code under `code` outside an error logs it under another
key.
