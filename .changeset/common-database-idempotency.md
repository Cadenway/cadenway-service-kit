---
'@cadenway/nest-common': minor
---

Add the `@cadenway/nest-common/database` entry point: transaction runners and `Idempotency-Key`.

- `DatabaseModule.forRoot`: a `pg` pool of 5 connections by default, `TenantTransactionRunner` and `SystemTransactionRunner`. The tenant runner issues `SET LOCAL app.organization_id` from the organization context when a use case transaction starts; the system runner issues `SET LOCAL app.system_access` for work that crosses organizations.
- `organizationPolicy()` and `organizationIsolation`: the row-level security policy every table with an `organization_id` declares.
- `@Idempotent()`, `IdempotencyInterceptor` (option `idempotency: true`), the `idempotencyKeys` table and `purgeExpiredIdempotencyKeys`: the same key with another body answers 422, a request still running 409, and the response is replayed for 24 hours.
- `databaseConfigShape` (`DATABASE_URL`).

`drizzle-orm` and `pg` become optional peer dependencies, needed by this entry point only: nothing changes for a gateway without a database.

For every service that enables idempotency: re-export `idempotencyKeys` from a `*.schema.ts` file, generate the migration, and add `ALTER TABLE "idempotency_keys" FORCE ROW LEVEL SECURITY;` to it.
