---
'@cadenway/nest-common': minor
---

Add the internal HTTP client.

- `InternalHttpClient`, on the native `fetch`: the internal token on every call, a deadline of 2 seconds at most taken from the time left to the current request, one retry of an idempotent call after a connection error or a 503, one circuit breaker per called service, and every failure thrown as an `application/problem+json` problem with a stable `upstream.*` code.
- `requestDeadlineMiddleware`, `runWithDeadline`, `remainingBudgetMs` and the `X-Request-Timeout-Ms` header, which carries the time left from one backend to the next.

Nothing is installed implicitly: an application builds its clients and registers the middleware.
