---
paths:
  - 'packages/nest-common/**'
---

# Common plumbing

Follow the [internal token contract](../../docs/integration.md#internal-token) for issuer, audience,
key selection and route subjects. Tokens use Ed25519 JWTs with `kid` and a 60-second lifetime.
Load signing keys and trusted issuer keys from configuration. A service calls another only to act.
The default route requires an organization and refuses an anonymous subject. Anonymous or system
routes declare their subject. Organization scope comes only from the verified token and travels
in `AsyncLocalStorage`.

Use only the [tenant and system runners](../../docs/integration.md#transaction-runners) to open
transactions and set their scope. Keep `drizzle-orm` and `pg` optional behind `/database`.
A gateway without a database imports only the main entry point.

Follow the [idempotency contract](../../docs/integration.md#idempotency-key). The interceptor
stores the key and response in the service's use case transaction. Return 422 for a reused key
with another body, 409 for a request in progress, and replay for 24 hours. The gateway relays
the header and stores nothing. Table changes ship a migration and a note for every service.

## Review example

For example, a change to the transaction runner can alter how long every service holds a database
connection. Exercise a callback failure with real PostgreSQL and verify rollback, release of the
connection, and isolation of the next transaction's organization context.
