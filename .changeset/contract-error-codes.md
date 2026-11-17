---
'@cadenway/nest-common': minor
---

Answer the error codes the contracts declare for cursors and entity tags. This is a visible change
of the responses, released as a minor so that it is never taken for a drop-in patch; no exported
declaration changes.

- `decodeCursor` answers a malformed cursor, or one issued for other filters or another sort, with
  `400 request.invalid` and one `details.issues` entry
  `{ in: 'query', path: 'cursor', code: 'invalid_cursor' }`. It answered
  `400 pagination.cursor-invalid`, a code no contract declares.
- `parseIfMatch` and `@IfMatch()` answer a malformed `If-Match` with `400 request.invalid` and one
  issue `{ in: 'header', path: 'If-Match', code: 'invalid_format' }`. They answered
  `400 request.if-match-invalid`.
- `assertVersionMatch` answers a stale `If-Match` with `412 request.version-mismatch` and the stored
  version as `details.version`. It answered `412 precondition.failed` with
  `details.currentVersion`; that member is gone.
- `assertVersionMatch` with `{ required: true }` answers a missing `If-Match` with
  `400 request.invalid` and one issue `{ in: 'header', path: 'If-Match', code: 'invalid_type' }`. It
  answered `400 request.if-match-required`, which no contract declares either.

Migration: a client or a test that matched one of the four old codes, or read
`details.currentVersion`, matches the new code and `details.version`. A service that caught these
problems to answer the contract codes itself (identity-service for the API token cursor and the
`If-Match` of the profile, organization-service for its list cursors and `If-Match`) can drop the
`catch` around `decodeCursor` and `parseIfMatch` once it runs this version; it keeps its own
`request.invalid` for the checks it makes on a decoded position (sort values, id form). Issues
in `header` are not listed by the released `ValidationIssue` type, whose declaration stays
unchanged: code that reads `details.issues` of any origin also expects `in: 'header'`.
