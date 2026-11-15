---
'@cadenway/nest-common': patch
---

Document consistently when the system transaction runner serves a request: the README and the `SystemTransactionRunner` docblock said both that it serves routes without an organization and that it must never serve the request of a user. They now say what the code does: a request that carries an organization goes through the tenant runner, a request without one (sign-up, sign-in, a route with an anonymous or system subject, a user acting outside any organization) is served in a system transaction, as the `Idempotency-Key` interceptor does. No behavior changes.
