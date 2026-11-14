---
'@cadenway/nest-common': minor
---

Address the security, reliability and API reviews of the unreleased additions.

- Logs: SQL values never reach a line (the statement, parameters, `detail` and `where` of a database error are dropped); redacted keys are masked at any depth whatever their case and separators; e-mail addresses are masked inside logged objects too.
- Transaction runners: a connection lost during a transaction no longer crashes the process; a `COMMIT` that PostgreSQL turns into a rollback throws `TransactionAbortedError`; the scope dies with its transaction; `tx.db` has no `transaction` method (type `TransactionDatabase`); joining a less strict transaction throws.
- Internal HTTP client: a path outside the called service throws and redirects are refused; a timeout shortened by the request budget and a caller abort no longer count for the circuit breaker.
- `createApplication`: `internalTokenVerification` defaults to `required` and throws without a verifier; `acceptIncomingRequestTimeout`; the telemetry flush runs after the application closed its resources, within 3 seconds.
- Internal token: `organizationId` must be a UUID; `@InternalAccess` on a method is merged over the one on its class.
- `Idempotency-Key`: the stored response belongs to the actor that obtained it; `@Idempotent({ isolationLevel })`.
- Codes renamed before any release: `pagination.cursor-invalid`, `request.if-match-invalid`; a 412 is always `precondition.failed`.
- `version` is optional for `LoggingModule` and `startTelemetry` and defaults to `readPackageVersion()`.
- `@nestjs/platform-express` is declared as a peer dependency.
- No longer exported, as nothing outside the package uses them: `createLoggerParams`, `resolveRequestId`, `filterFingerprint`, `getActiveTransaction`, and the third parameter of `runWithDeadline`.
