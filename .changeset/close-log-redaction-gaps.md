---
'@cadenway/nest-common': patch
---

Security: close five paths that let a redacted value (a password, a token, a cookie, an e-mail
address, SQL values) reach the logs unmasked. Every logger the logging module creates applies the
same redaction, including the request loggers, their children and the fields bound to them:

- an `Error` under a key other than `err`, at any depth, or in a plain member of another error
  (the `options.cause` NestJS keeps on an `HttpException`, so on a `ProblemException`) is written
  as `err` is: `type`, `message`, `stack` and its members, sanitized, SQL fields dropped, the fixed
  database message, its machine `code` kept. It was written as its raw enumerable members, the
  `detail` of a database error included, without `message` or `stack`. The start-up line of
  `runApplication` follows the same rule for an error held in a plain member of the failure;
- the bindings of `child()`, `setBindings()` and the `assign()` and `runInContext()` of
  `PinoLogger` are sanitized like the fields of a line, and the e-mail addresses of a child's
  `msgPrefix` are masked; they were written as given;
- an object interpolated into the message with `%j`, `%o` or `%O` is sanitized like a logged
  object, and an `Error` interpolated is written as the string of its name and sanitized message
  (which `%j`, `%o` and `%O` quote), no longer as the JSON of its enumerable members;
- the message pino takes from an error logged without one follows the rule of `err.message`: the
  fixed database message for a database error or a wrapper of one, e-mail addresses masked
  otherwise;
- a request or response object, or the shallow copy of one that the NestJS `Logger` and a
  `PinoLogger` with a context make, under any key, under `req` or `res`, or as the line itself, is
  written as `{ id, method, route }` (the request id, the method, the route pattern), as
  `{ statusCode }` for a response and `{ method }` for an outgoing request. A walked request wrote
  its `rawHeaders` (the cookies and the bearer token), its path and query string and its socket; a
  walked response its `Set-Cookie` header; under `req` a request wrote `url`, query string
  included, and `params`, which are no longer written.

Lines whose output changes: those carrying one of the values above. Also, a class instance bound
to a logger or interpolated is now written as its own enumerable members, as it already was in the
fields of a line: a `URL` gives `[object Object]` with `%s`, `{}` with `%j` and `{}` as a binding,
where it gave its address. A value that throws while it is read is written as `[REDACTED]` instead
of failing the log call. The completion line of a request, the `err` field, the fields that hold
none of these values and a message given as text without interpolated values are written as
before.

Migration: a service that read `url` or `params` from a request it logged under `req` uses the
`route` field; one that interpolated an `Error` with `%j` to read its members logs it under `err`;
one that interpolates or binds a `URL` or another class instance logs its text (`url.href`).

This changes a default without an option, a deliberate security exception to "default unchanged",
released as a patch like the earlier tightenings of the redaction; no exported declaration changes.
