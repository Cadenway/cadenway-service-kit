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
  `detail` of a database error included, without `message` or `stack`;
- the bindings of `child()`, `setBindings()` and the `assign()` and `runInContext()` of
  `PinoLogger` are sanitized like the fields of a line; they were written as given;
- an object interpolated into the message with `%j`, `%o` or `%O` is sanitized like a logged
  object, and an `Error` interpolated is written as its name and sanitized message (the text `%s`
  gave), no longer as the JSON of its enumerable members;
- the message pino takes from an error logged without one follows the rule of `err.message`: the
  fixed database message for a database error or a wrapper of one, e-mail addresses masked
  otherwise;
- a request or response object, under any key, under `req` or `res`, or as the line itself, is
  written as `{ id, method, route }` (the request id, the method, the route pattern), as
  `{ statusCode }` for a response and `{ method }` for an outgoing request. A walked request wrote
  its `rawHeaders` (the cookies and the bearer token), its path and query string and its socket;
  under `req` it wrote `url`, query string included, and `params`, which are no longer written.

Lines whose output changes: those carrying one of the values above. The completion line of a
request, the `err` field, the fields that hold none of these values and a message given as text
without interpolated values are written as before.

This changes a default without an option, a deliberate security exception to "default unchanged",
released as a patch like the earlier tightenings of the redaction; no exported declaration changes.
