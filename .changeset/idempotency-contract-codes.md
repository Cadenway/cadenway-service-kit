---
'@cadenway/nest-common': minor
---

Answer the `Idempotency-Key` codes the contracts declare, and replay the `ETag` of a stored
response. This is a visible change of the responses of `@Idempotent()` routes, released as a minor
so that it is never taken for a drop-in patch; no exported declaration and no table changes.

- A request whose key is still running answers `409 idempotency.request-in-progress`, with the same
  detail. It answered `409 idempotency.in-progress`, a code no contract declares.
- A malformed key answers `400 request.invalid` with one `details.issues` entry
  `{ in: 'header', path: 'Idempotency-Key', code: 'invalid_format' }`, without quoting the key. It
  answered `400 idempotency.key-invalid`, which no contract declares. The accepted shape is
  unchanged: 1 to 255 printable ASCII characters.
- A replay sets the stored `ETag` as well as `Location`. An `ETag` the handler set itself, for a
  body without a top-level `version`, was dropped and the replay carried the weak `ETag` Express
  derives from the body. No other header is stored, and a replay sets no other header even from a
  row that holds one.
- `idempotency.key-required` (a route declared with `{ required: true }`) and
  `idempotency.key-reused` are unchanged.

Migration: a client or a test that matched `idempotency.in-progress` or `idempotency.key-invalid`
matches `idempotency.request-in-progress`, or `request.invalid` with the issue on the header. A
service that documented these answers as a deviation from its contract (task-service) drops that
note once it runs this version. Responses stored before the upgrade hold `Location` only: for up
to 24 hours their replay carries, as before, only an `ETag` derived from the replayed body.
