---
'@cadenway/nest-common': patch
---

A request body that is not valid JSON no longer exposes any part of itself.

- The response changes, as a security and contract-conformance fix shipped in a patch: such a body now answers `400 request.invalid`, the code the contracts declare for a body that does not match its schema, with the fixed detail `The request body is not valid JSON.` and one `details.issues` entry (`in: body`, `path: ""`, `code: invalid_json`). It answered `400 http.bad-request`, a code no contract declares, with the text of `JSON.parse` as `detail`, which quotes the characters around the faulty token: on a sign-up, sign-in or verification body, part of a password. A client that matched `http.bad-request` for a malformed body must match `request.invalid`.
- The JSON parser that `applyJsonBodyLimit` (and so `createApplication`) registers hands on that fixed problem instead of the parser error, which also held the whole body. The span the Express instrumentation opens around the parser records a `ProblemException` with the message `request.invalid: The request body is not valid JSON.`, and nothing of the body reaches the logs.
- `ProblemFilter` and `toProblem` give the same response to the refusal of the JSON parser NestJS registers itself, in an application that does not call `applyJsonBodyLimit`; on that path the span of the parser still records its text.
- Every other refusal of the body parser keeps its mapping: a body over the limit still answers `400 request.body-too-large`.
- Migration note: `applyJsonBodyLimit` registers the parser of this package through `app.use` (a new optional member of `BodyParserHost`; a host without it gets `useBodyParser` as before). That parser does not keep the raw body, so an application created with `{ rawBody: true }` that calls `applyJsonBodyLimit` gets no `req.rawBody` on JSON requests. `createApplication` never enables `rawBody`, so services and gateways built with it see no difference.
- The package now depends on `body-parser` directly, on the 2.x line Express 5 uses.
