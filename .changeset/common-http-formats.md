---
'@cadenway/nest-common': minor
---

Add the HTTP formats shared by every route.

- Errors: `ProblemException` and `ProblemFilter` answer `application/problem+json` (RFC 9457) with the `code` and `details` extensions; an unexpected error answers 500 `internal.unexpected` without any internal text.
- Validation: `ZodValidationPipe` and `zodDto`; an unknown query parameter answers 400 `request.invalid`.
- Pagination: `encodeCursor`, `decodeCursor`, `filterFingerprint`, `buildPage` and `pageQueryShape` (`limit` from 1 to 100, 50 by default).
- Entity tags: `EtagInterceptor`, `@IfMatch()`, `assertVersionMatch`, `formatEtag` and `parseIfMatch`.
- Body limit: `applyJsonBodyLimit` and `JSON_BODY_LIMIT_BYTES` (1 MB).

Nothing is installed implicitly: an application registers the filter, the pipe and the interceptor itself until the bootstrap helper does it.
