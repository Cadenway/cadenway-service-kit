---
paths:
  - 'packages/nest-common/**'
---

# Common plumbing

- The internal token is a JWT signed with `alg: Ed25519`, valid 60 seconds, with `aud` set to the
  called service and a `kid` header. Several services issue it: the API gateway, the realtime
  gateway, automation-service and integration-service. A service calls another one to act, never to
  read.
- Signing keys, trusted issuers and their verification keys come from configuration; nothing is
  hard-coded. A verification key is accepted only for the issuer it is configured under.
- A route with no user or organization (sign-up, sign-in, introspection, intake form, webhooks) is
  still called with a token, whose subject is anonymous or system. The route declares it: the default
  requires an organization and refuses an anonymous subject.
- The organization context comes from the verified token only, never from a path, a query string or
  a body. It travels in an `AsyncLocalStorage`.
- A transaction goes through one of the two runners. The tenant runner issues
  `SET LOCAL app.organization_id` from the organization context when a use case transaction starts.
  The system runner is for work that crosses organizations (outbox relay, schedules, events without
  an organization) and issues `SET LOCAL app.system_access`. Nothing else opens a transaction or sets
  these parameters.
- `drizzle-orm` and `pg` are optional peers behind the `/database` entry point: a gateway without a
  database imports the main entry point only.
- `Idempotency-Key` is handled by an interceptor of the kit that stores the key and the response in
  the service's own database, inside the use case transaction. The same key with another body
  answers 422, a request still running 409, and the response is replayed for 24 hours. The gateway
  relays the header and stores nothing.
- A change to a table the kit ships ships its migration and a note for every service.
