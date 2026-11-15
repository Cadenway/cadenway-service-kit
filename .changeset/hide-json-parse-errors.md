---
'@cadenway/nest-common': patch
---

A request body that is not valid JSON no longer exposes any part of itself.

- The response changes: such a body now answers `400 request.invalid`, the code the contracts declare for a body that does not match its schema, with the fixed detail `The request body is not valid JSON.` and one `details.issues` entry (`in: body`, `path: ""`, `code: invalid_json`). It answered `400 http.bad-request` with the text of `JSON.parse` as `detail`, which quotes the characters around the faulty token: on a sign-up, sign-in or verification body, part of a password. A client that matched `http.bad-request` for a malformed body must match `request.invalid`.
- The JSON parser that `applyJsonBodyLimit` (and so `createApplication`) registers hands on that fixed problem instead of the parser error, which also held the whole body. The span the Express instrumentation opens around the parser records a `ProblemException` with the message `request.invalid: The request body is not valid JSON.`, and nothing of the body reaches the logs.
- `ProblemFilter` and `toProblem` answer the same problem for the JSON parser NestJS registers itself, in an application that does not call `applyJsonBodyLimit`.
- Every other refusal of the body parser keeps its mapping: a body over the limit still answers `400 request.body-too-large`.
- `applyJsonBodyLimit` registers the parser through `app.use`: `BodyParserHost` gains `use`, and its `useBodyParser` is deprecated, no longer called, and removed in the next major. The parser does not keep the raw body, so the `rawBody` option of NestJS has no effect on JSON bodies. The package now depends on `body-parser` directly, the version Express installs.
