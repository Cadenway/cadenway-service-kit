# @cadenway/nest-common

Plumbing shared by the Cadenway NestJS services and gateways. Implemented today: typed
configuration, structured logs, OpenTelemetry start-up, the HTTP formats (errors, validation,
pagination, entity tags, body limit), the internal token with the organization context, the
transaction runners with `Idempotency-Key`, the internal HTTP client, the health routes with
dependency indicators, and one bootstrap helper that applies all of it. The rest of what the
[repository instructions](../../AGENTS.md) list for this package is not implemented yet.

`@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `@opentelemetry/api`,
`reflect-metadata`, `rxjs` and `zod` are peer dependencies: the application provides them. `drizzle-orm` and `pg` are optional peers, needed
only by the `/database` entry point.

| Entry point                       | Holds                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `@cadenway/nest-common`           | Bootstrap, configuration, logs, HTTP formats, internal token, internal HTTP client, route-name interceptor, health module |
| `@cadenway/nest-common/database`  | PostgreSQL pool, tenant and system transaction runners, `Idempotency-Key`                                                 |
| `@cadenway/nest-common/telemetry` | `startTelemetry`, for the preloaded `telemetry.js`                                                                        |
| `@cadenway/nest-common/hook.mjs`  | Module loader of the OpenTelemetry instrumentations, for Node                                                             |

## Bootstrap

`createApplication` creates the NestJS application with every shared format applied, so the
`main.ts` of a service stays a few lines:

```ts
import { createApplication, loadConfig } from '@cadenway/nest-common';

import { AppModule } from './app.module.js';
import { appConfigSchema } from './config/app-config.js';

const config = loadConfig(appConfigSchema);
const app = await createApplication(AppModule, {
  service: 'task-service',
  config,
  internalToken: {
    verifier: {
      audience: config.INTERNAL_TOKEN_AUDIENCE,
      trustedIssuers: config.INTERNAL_TOKEN_TRUSTED_ISSUERS,
    },
  },
});
await app.listen(config.PORT);
```

| Installed                                                                                                                                   | From                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Structured logs, NestJS logger routed to them                                                                                               | [Logs](#logs)                                                |
| `ProblemFilter` for every error                                                                                                             | [Errors](#errors)                                            |
| `ZodValidationPipe` for `zodDto` parameters                                                                                                 | [Validation](#validation)                                    |
| `RouteNameInterceptor`                                                                                                                      | [Telemetry](#telemetry)                                      |
| `EtagInterceptor`                                                                                                                           | [Entity tags](#entity-tags)                                  |
| Internal token guard and organization context                                                                                               | [Internal token](#internal-token), only with `internalToken` |
| JSON body limit of 1 MB                                                                                                                     | [Body limit](#body-limit)                                    |
| Request deadline of 10 seconds                                                                                                              | [Request deadline](#request-deadline)                        |
| Shutdown hooks; telemetry flushed after the application closed its own resources, within 3 seconds, a failed flush being logged and ignored | `shutdownTelemetry`                                          |

It does not listen, and it imports neither `HealthModule` nor `DatabaseModule`: the module of the
application declares what it depends on.

| Option                         | Default                          | Effect                                                                                                                                                                                             |
| ------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service`                      | Required                         | Name in the logs                                                                                                                                                                                   |
| `version`                      | `readPackageVersion()`           | Version in the logs, read from `package.json` in the working directory, `0.0.0` when missing                                                                                                       |
| `config`                       | `info`, JSON lines, `production` | `LOG_LEVEL`, `LOG_PRETTY` and `NODE_ENV` of the validated configuration                                                                                                                            |
| `internalToken`                | None                             | Verifier and signer options                                                                                                                                                                        |
| `internalTokenVerification`    | `required`                       | `createApplication` throws when `internalToken.verifier` is missing, so a service cannot start with open routes by omission. `off` is for a public gateway, which authenticates its callers itself |
| `acceptIncomingRequestTimeout` | `true`                           | Lets the caller shorten the request budget with `X-Request-Timeout-Ms`; a public edge sets `false`                                                                                                 |
| `requestBudgetMs`              | 10 000                           | Time a request may take, bounding its calls to other services                                                                                                                                      |
| `jsonBodyLimitBytes`           | 1 048 576                        | Largest JSON body                                                                                                                                                                                  |
| `acceptIncomingRequestId`      | `true`                           | Keeps a well-formed incoming `X-Request-Id`                                                                                                                                                        |
| `logDestination`               | stdout                           | Stream that receives the lines, for tests                                                                                                                                                          |

A service sets `internalToken.verifier`. A public gateway, which authenticates sessions, sets
`internalToken.signer` only, `internalTokenVerification: 'off'`, and `false` for both
`acceptIncomingRequestId` and `acceptIncomingRequestTimeout`.

The telemetry of the same service is one more file, preloaded before `main.js`:

```ts
import { readPackageVersion, startTelemetry } from '@cadenway/nest-common/telemetry';

startTelemetry({ service: 'task-service', version: readPackageVersion() });
```

## Configuration

The environment is validated once, at start-up, against a zod schema. A missing or invalid variable
throws a `ConfigError` that names every faulty variable and never prints a value.

```ts
import { baseConfigShape, loadConfig, type BaseConfig } from '@cadenway/nest-common';
import { z } from 'zod';

export interface AppConfig extends BaseConfig {
  readonly DATABASE_URL: string;
}

export const appConfigSchema: z.ZodType<AppConfig> = z.object({
  ...baseConfigShape,
  DATABASE_URL: z.url(),
});

export const config: Readonly<AppConfig> = loadConfig(appConfigSchema);
```

- `loadConfig(schema, env = process.env)` returns the frozen, typed configuration. A variable set
  to an empty string counts as unset.
- `ConfigModule.forRoot({ schema, env })` validates while the application module is declared and
  provides the result globally under the `CONFIG` token (`@Inject(CONFIG)`).

Variables of `baseConfigShape`:

| Variable     | Values                                                       | Default      |
| ------------ | ------------------------------------------------------------ | ------------ |
| `NODE_ENV`   | `development`, `test`, `production`                          | `production` |
| `PORT`       | Integer from 1 to 65535                                      | Required     |
| `LOG_LEVEL`  | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent` | `info`       |
| `LOG_PRETTY` | `true` or `false`                                            | `false`      |

## Logs

`LoggingModule.forRoot(options)` installs `nestjs-pino`. An application never configures pino
itself; it injects `Logger` or `PinoLogger`, re-exported by this package.

```ts
LoggingModule.forRoot({
  service: 'task-service',
  version: '1.4.0',
  level: config.LOG_LEVEL,
  pretty: config.LOG_PRETTY,
  environment: config.NODE_ENV,
});
```

Every line is one JSON object with `level` (as a label), `time` (ISO 8601, UTC), `service`,
`version`, `msg` and, inside a request, `requestId`; inside a traced request, `traceId` and
`spanId`; inside an organization context, `organizationId` and, for a user, `userId`. Each request writes one completion line, `request completed` or `request failed`, with
`method`, `route` (the matched pattern, `null` when no route matched), `status` and `durationMs`:
`info` below 400, `warn` from 400, `error` from 500.

| Never written                                 | Why                                                                                                                                                             |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request and response bodies, headers, cookies | The request object is not attached to the lines                                                                                                                 |
| Query strings and raw paths                   | Only the route pattern is logged                                                                                                                                |
| Remote addresses                              | Same                                                                                                                                                            |
| Probe requests under `/health/`               | A probe every few seconds would bury the traffic                                                                                                                |
| Values of the redacted keys                   | Replaced by `[REDACTED]` at any depth, whatever the case and separators of the key                                                                              |
| Anything nested deeper than six levels        | Replaced whole by `[REDACTED]`: a line carries identifiers, not payloads                                                                                        |
| SQL values                                    | The `query`, `params`, `detail` and `where` of a database error are dropped, and the `params:` line of a failed Drizzle query is cut from its message and stack |
| E-mail addresses                              | Replaced by `[REDACTED]` in every message, logged error and string value of a logged object                                                                     |

Redacted keys (`DEFAULT_REDACTED_KEYS`): `authorization`, `cookie`, `set-cookie`, `password`,
`currentPassword`, `newPassword`, `token`, `accessToken`, `refreshToken`, `idToken`,
`sessionToken`, `secret`, `clientSecret`, `apiKey`, `privateKey`, `privateJwk`,
`internalTokenPrivateJwk`, `databaseUrl`, `connectionString`, `email`. A key matches whatever its
case and separators: `accessToken`, `access_token` and `Access-Token` are one key.

### Options

| Option                    | Default                | Effect                                                                                                                                           |
| ------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `service`                 | Required               | `service` field                                                                                                                                  |
| `version`                 | `readPackageVersion()` | `version` field; the version of `package.json` in the working directory, `0.0.0` when missing                                                    |
| `level`                   | `info`                 | Minimum level written                                                                                                                            |
| `pretty`                  | `false`                | Uses the `pino-pretty` transport of the application's own `devDependencies`; throws when `environment` is `production` or the package is missing |
| `environment`             | `production`           | Runtime environment, used to refuse `pretty`                                                                                                     |
| `redactKeys`              | `[]`                   | Keys masked in addition to the defaults; the defaults cannot be removed                                                                          |
| `acceptIncomingRequestId` | `true`                 | Keeps a well-formed incoming `X-Request-Id` (8 to 128 characters among letters, digits, `.`, `_`, `:`, `-`)                                      |
| `destination`             | stdout                 | Stream that receives the lines, for tests; ignored with `pretty`                                                                                 |

### Request id

The logging middleware gives every request an id: the incoming `X-Request-Id` when it is accepted
and well formed, a random UUID otherwise. The id is set on the response as `X-Request-Id`, written
as `requestId` in the lines, and readable with `requestIdOf(request)`.

## Telemetry

Traces and metrics come from the OpenTelemetry SDK, started before the application code is loaded.
An application has one `telemetry.ts`:

```ts
import { startTelemetry } from '@cadenway/nest-common/telemetry';

startTelemetry({ service: 'task-service', version: '1.4.0' });
```

and starts with:

```bash
node --experimental-loader=@cadenway/nest-common/hook.mjs --import ./dist/telemetry.js dist/main.js
```

`@cadenway/nest-common/hook.mjs` re-exports `@opentelemetry/instrumentation/hook.mjs`. The
application cannot name the OpenTelemetry file directly: it is a dependency of this package, not of
the application, and pnpm's strict `node_modules` does not expose it
(`ERR_MODULE_NOT_FOUND`, checked from a packed install).

| Concern          | Behavior                                                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instrumentations | HTTP, Express, pg, ioredis and undici (`fetch`)                                                                                                     |
| Propagation      | `traceparent` (W3C), the SDK default                                                                                                                |
| Export           | OTLP over HTTP to `OTEL_EXPORTER_OTLP_ENDPOINT`. Unset: spans are still created (trace ids in the logs, propagation) and nothing leaves the process |
| Invalid endpoint | `startTelemetry` throws when the variable is set to anything but an HTTP or HTTPS URL                                                               |
| Metrics          | Those of the instrumentations (request duration per route, pg pool) and `nodejs.eventloop.delay.p99`, only when a collector is configured           |
| Probes           | Requests under `/health/` are not traced                                                                                                            |
| Second call      | Returns the handle of the first                                                                                                                     |
| Shutdown         | `shutdownTelemetry()`, from either entry point, flushes and stops; it resolves at once when telemetry was never started                             |

`RouteNameInterceptor` (main entry point) names the server span `<METHOD> <route>` and sets
`http.route`, which the HTTP instrumentation also copies onto the request duration metric.
`nameHttpSpan(method, route)` does the same from other code.

Not installed, on purpose: `@opentelemetry/instrumentation-nestjs-core` (its supported range stops
before NestJS 12) and `@opentelemetry/instrumentation-router` (it duplicates the spans of
Express 5).

## Errors

Every error leaves as `application/problem+json` (RFC 9457) with the Cadenway extensions `code`
and `details`. Register `ProblemFilter` globally and throw `ProblemException`:

```ts
throw new ProblemException({
  status: 404,
  code: 'task.not-found',
  detail: 'No such task in this organization.',
});
```

```json
{
  "type": "about:blank",
  "title": "Not Found",
  "status": 404,
  "code": "task.not-found",
  "detail": "No such task in this organization."
}
```

`status` is one of 400, 401, 403, 404, 409, 412, 422, 429 and 503. `code` is `<domain>.<reason>`,
each part in kebab-case. `title` defaults to the standard phrase of the status and `type` to
`about:blank`; `detail`, `instance` and `details` are optional. Human texts are English:
applications translate from `code`.

| Thrown                                 | Response                                                       |
| -------------------------------------- | -------------------------------------------------------------- |
| `ProblemException`                     | Its problem, as is                                             |
| `HttpException` with an allowed status | That status, the matching `http.*` code, its message as detail |
| `HttpException` with another status    | 400 for a client error, 503 for a server error                 |
| JSON body over the size limit          | 400 `request.body-too-large`                                   |
| Anything else                          | 500 `internal.unexpected`, with no detail                      |

Codes produced by this package: `http.bad-request`, `http.unauthorized`, `http.forbidden`,
`http.not-found`, `http.conflict`, `http.unprocessable-content`,
`http.too-many-requests`, `http.service-unavailable`, `internal.unexpected`, `request.invalid`,
`request.body-too-large`, `request.if-match-invalid`, `request.if-match-required`,
`precondition.failed` and `pagination.cursor-invalid`.

- A stack trace or the text of an unexpected error is never sent. From status 500 the error is
  handed to the request logger, which writes it on the `request failed` line.
- 500 is the one status outside the contract set: an unexpected failure is a defect and must not
  look retryable the way a 503 does.
- A 401 carries `WWW-Authenticate: Bearer`.
- The error reference shown by the web application is the `X-Request-Id` response header.

## Validation

`ZodValidationPipe` validates a controller parameter with a zod schema, usually one generated by
`@cadenway/contracts`, and hands the parsed value to the handler.

```ts
// Per parameter, with a schema.
@Post()
create(@Body(new ZodValidationPipe(createTaskBodySchema)) body: CreateTaskBody) {}

// Globally (`app.useGlobalPipes(new ZodValidationPipe())`), through a typed parameter.
class ListTasksQuery extends zodDto(listTasksQuerySchema) {}

@Get()
list(@Query() query: ListTasksQuery) {}
```

A failure answers 400 `request.invalid` with one `details.issues` entry per issue:
`{ in, path, code, message }`. Messages name the expectation and never the received value.

- **An unknown query parameter answers 400** (`unrecognized_parameter`) when the query schema is a
  `z.object`. A schema wrapped by `.transform()` or `.pipe()` cannot be inspected: write the object
  first.
- Body and path values follow the schema as written: zod drops unknown body members unless the
  schema is strict.
- Registered globally, the pipe leaves a parameter whose type is not a `zodDto` class untouched.

## Pagination

Lists use cursor pagination with the `{ items, nextCursor }` shape. The cursor is opaque: base64url
of the sort values, the id of the last row and a fingerprint of the filters.

```ts
const filters = { status: query.status, sort: '-dueDate' };
const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, filters);
const rows = await repository.list({ after, limit: query.limit + 1 });
return buildPage(rows, query.limit, (last) =>
  encodeCursor({ sort: [last.dueDate], id: last.id }, filters),
);
```

| Helper                             | Behavior                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `pageQueryShape`                   | Zod shape of `cursor` and `limit`: `limit` from 1 to 100, 50 by default                |
| `encodeCursor(position, filters)`  | Pass everything that defines the list as `filters`: the filters and the sort           |
| `decodeCursor(cursor, filters)`    | 400 `pagination.cursor-invalid` for a malformed cursor or one issued for other filters |
| `buildPage(rows, limit, cursorOf)` | Expects `limit + 1` rows; `nextCursor` is `null` on the last page                      |

The cursor is not signed and not secret: it only positions a query that still filters on the
organization of the verified token.

## Entity tags

The `version` of an aggregate is its `ETag`.

| Helper                                                   | Behavior                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `EtagInterceptor`                                        | Sets `ETag: "<version>"` when a handler returns an object with an integer `version`; lists are left alone    |
| `@IfMatch()`                                             | Hands the parsed `If-Match` header to the handler; a malformed header answers 400 `request.if-match-invalid` |
| `assertVersionMatch(condition, currentVersion, options)` | 412 `precondition.failed` when the versions differ. Call it inside the transaction that writes               |
| `formatEtag(version)`, `parseIfMatch(header)`            | The underlying conversions                                                                                   |

`If-Match` is optional by default. With `{ required: true }`, for routes that edit long texts, a
request without the header answers 400 `request.if-match-required` (428 is not a status of the
contract set). A weak tag (`W/"7"`) never matches, as `If-Match` requires a strong comparison.

## Body limit

`applyJsonBodyLimit(app, limitBytes = JSON_BODY_LIMIT_BYTES)` registers the JSON body parser with
a limit of 1 MB (1 048 576 bytes). Call it before the application is initialized. A larger body
answers 400 `request.body-too-large`; a malformed one answers 400 `http.bad-request`.

## Internal token

A service never receives the credential of a user. Every call between backends carries an
internal token: a JWT signed with `alg: Ed25519`, valid 60 seconds, with `aud` set to the called
service and a `kid` header.

Several services issue it: the API gateway, the realtime gateway, automation-service and
integration-service. Each has its own key; a called service lists the issuers it trusts with their
verification keys. A key is accepted only for the issuer it is configured under.

```ts
InternalTokenModule.forRoot({
  // This service receives internal calls.
  verifier: {
    audience: config.INTERNAL_TOKEN_AUDIENCE,
    trustedIssuers: config.INTERNAL_TOKEN_TRUSTED_ISSUERS,
  },
  // This service calls other services.
  signer: {
    issuer: config.INTERNAL_TOKEN_ISSUER,
    privateJwk: config.INTERNAL_TOKEN_PRIVATE_JWK,
  },
});
```

Both options are optional and independent. With `verifier`, the module registers
`InternalTokenGuard` and `OrganizationContextInterceptor` for every HTTP route. With `signer`,
`InternalTokenSigner` can be injected. With neither, nothing changes.

### Configuration

Keys and issuers come from the environment, never from code. Spread
`internalTokenVerifierConfigShape` and `internalTokenSignerConfigShape` into the application
schema.

| Variable                         | Value                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `INTERNAL_TOKEN_AUDIENCE`        | Name of this service, lowercase kebab-case (`task-service`): the `aud` it accepts                |
| `INTERNAL_TOKEN_TRUSTED_ISSUERS` | One line of JSON: `{"<issuer>":[{"kty":"OKP","crv":"Ed25519","x":"<public>","kid":"<key id>"}]}` |
| `INTERNAL_TOKEN_ISSUER`          | Name of this service, written as `iss`                                                           |
| `INTERNAL_TOKEN_PRIVATE_JWK`     | One line of JSON, a secret: `{"kty":"OKP","crv":"Ed25519","x":"...","d":"...","kid":"<key id>"}` |

None has a default. Several keys under one issuer allow a rotation: add the new key to the
verifiers, switch the signer, then remove the old key. A private key listed among the verification
keys is refused at start-up.

### Claims and subjects

`signer.sign(audience, claims)` takes who the call is made for. `organizationId` is a UUID, as every
entity id of the contracts:

| Claim            | Content                                                                             |
| ---------------- | ----------------------------------------------------------------------------------- |
| `actor`          | `{ type, id }` with `type` among `user`, `automation`, `git`, `system`, `anonymous` |
| `organizationId` | Organization of the call, or `null`                                                 |
| `role`           | Member role of a user, `null` by default                                            |
| `scopes`         | Scopes granted to the caller, none by default                                       |
| `traceId`        | Trace id of the request, optional; the trace itself travels in `traceparent`        |

A `user`, an `automation` and a `git` actor carry an id. An `anonymous` actor carries no id, no
organization, no role and no scope; `system` may carry no id. Inconsistent claims are refused at
signing and at verification.

### Routes

Every HTTP route requires a valid token. By default it also requires an organization and refuses
an anonymous actor. A route that differs declares it:

```ts
// No user and no organization yet: sign-up, sign-in, the intake form.
@InternalAccess({ actors: ['anonymous'], organization: 'optional' })

// Introspection or a webhook: the calling service acts as itself.
@InternalAccess({ actors: ['system'], organization: 'optional' })

// An action reserved to one caller.
@InternalAccess({ issuers: ['automation-service'], actors: ['automation'] })
```

| Option         | Default                               | Effect                                          |
| -------------- | ------------------------------------- | ----------------------------------------------- |
| `actors`       | `user`, `automation`, `git`, `system` | Actor types the route accepts                   |
| `organization` | `required`                            | `optional` accepts a token with no organization |
| `issuers`      | Every trusted issuer                  | Issuers the route accepts                       |

A declaration on a method is merged over the one on its class: each option it sets replaces the
class one, the others are kept, so an `issuers` restriction of a controller survives. `@SkipInternalToken()` exempts a route
from the token altogether; `HealthModule` uses it for the probes, and nothing that reads or writes
data should.

| Situation                                    | Answer                                          |
| -------------------------------------------- | ----------------------------------------------- |
| No `Authorization: Bearer` header            | 401 `auth.token-missing`                        |
| Token refused                                | 401 `auth.token-invalid`, with `details.reason` |
| Issuer not accepted by the route             | 403 `auth.issuer-not-allowed`                   |
| Actor type not accepted by the route         | 403 `auth.actor-not-allowed`                    |
| No organization on a route that requires one | 403 `auth.organization-required`                |

`details.reason` is one of `malformed`, `issuer` (not trusted), `key` (unknown `kid` for that

issuer), `signature`, `audience`, `expired` (older than 60 seconds, whatever its own expiry says;
5 seconds of clock difference are tolerated, see `clockToleranceSeconds`) and `claims`.

The signer and the verifier options also take `clock`, a function returning the current date:
the system clock by default, a test seam otherwise.

### Organization context

The organization and the actor of a request come from the verified token only: never from a path,
a query string or a body. The interceptor carries them in an `AsyncLocalStorage`:

| Function                                  | Returns                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| `getOrganizationContext()`                | `{ organizationId, actor, role, scopes }`, or `undefined` outside any context |
| `requireOrganizationId()`                 | The organization id; throws when there is none (a programming error)          |
| `principalOf(request)`                    | The verified principal of a request, with `issuer`, `audience` and `traceId`  |
| `runWithOrganizationContext(context, fn)` | Runs work inside a context                                                    |

`runWithOrganizationContext` is for trusted entry points other than HTTP: the handler of an event
whose envelope was validated against its contract, or of a job the service itself enqueued. An
application never calls it for an HTTP request, and never builds a context from request data.

## Internal HTTP client

`InternalHttpClient` calls one other Cadenway service on the native `fetch` of Node. Build one per
called service and give it to the generated client as its fetch implementation.

```ts
{
  provide: TASK_SERVICE_CLIENT,
  inject: [InternalTokenSigner],
  useFactory: (signer: InternalTokenSigner) =>
    new InternalHttpClient({
      service: 'task-service',
      baseUrl: config.TASK_SERVICE_URL,
      signer,
    }),
}

const response = await client.fetch('/internal/v1/tasks/CAD-482');
```

| Concern         | Behavior                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Internal token  | Signed for the called service on every call, from the current organization context, or from `init.claims` outside one       |
| Deadline        | A call gets the time left to the current request, 2 seconds at most, and tells the called service in `X-Request-Timeout-Ms` |
| Retry           | One, for an idempotent call, after a connection error or a 503 only, when time is left                                      |
| Circuit breaker | One per client: opened by 5 consecutive failures, one trial call after 10 seconds                                           |
| Request id      | The `X-Request-Id` of the current request is forwarded                                                                      |
| Trace           | `traceparent` is added by the undici instrumentation of `startTelemetry`                                                    |
| Failures        | Thrown as `ProblemException`; `fetch` only resolves with a response below 400                                               |

`fetch(path, init)` takes a path of the called service, starting with one slash. Anything that
would resolve to another origin throws, and redirects are refused: the internal token never leaves
the called service.

A call is idempotent when its method is `GET`, `HEAD`, `PUT`, `DELETE` or `OPTIONS`, when it carries
an `Idempotency-Key` header, or when `init.idempotent` says so; and only a call without a body or
with a string body is sent again. A timeout is not retried.

| Outcome                               | Thrown                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 400, 403, 404, 409, 412, 422, 429     | The same status, with the `code`, `title`, `detail` and `details` of the called service's problem |
| Another client error                  | 400, with the `code` of the called service when it answered a problem, `upstream.error` otherwise |
| 401                                   | 503 `upstream.unauthorized`: the internal token was refused, a configuration defect               |
| 503                                   | 503 `upstream.unavailable`                                                                        |
| Another server error                  | 503 `upstream.failed`                                                                             |
| No connection                         | 503 `upstream.unreachable`                                                                        |
| No answer in time                     | 503 `upstream.timeout`                                                                            |
| Circuit open                          | 503 `upstream.circuit-open`, without calling                                                      |
| Time of the current request exhausted | 503 `upstream.deadline-exceeded`, without calling                                                 |

Every problem names the called service in `details.service`. Connection errors, timeouts and
server errors count as failures for the breaker. Client errors do not, and neither do a call its
caller aborted nor a timeout shortened by the budget of the incoming request: they say nothing
about the called service, and one caller with a tiny budget must not open the circuit for
everyone.

| Option                   | Default  | Effect                                          |
| ------------------------ | -------- | ----------------------------------------------- |
| `service`                | Required | `aud` of the tokens and name in the problems    |
| `baseUrl`                | Required | Base URL, from the `<SERVICE>_URL` variable     |
| `signer`                 | Required | `InternalTokenSigner` of this application       |
| `callTimeoutMs`          | 2000     | Longest time of one call; cannot exceed 2000    |
| `breakerThreshold`       | 5        | Consecutive failures that open the circuit      |
| `breakerHalfOpenAfterMs` | 10 000   | Time the circuit stays open before a trial call |
| `fetch`                  | Native   | Fetch implementation, for tests                 |

### Request deadline

`requestDeadlineMiddleware({ budgetMs })` opens the deadline of each incoming request: 10 seconds
by default, shortened to `X-Request-Timeout-Ms` when the caller sends a smaller positive integer.
It does not interrupt a handler that overruns; it bounds the calls the handler makes. With
`acceptIncoming: false` the header is ignored, which is what a public edge wants.
`remainingBudgetMs()` reads the time left and `runWithDeadline(budgetMs, work)` opens a deadline
outside HTTP.

## Database

Everything below comes from `@cadenway/nest-common/database`. A gateway without a database never
imports it, and needs neither `drizzle-orm` nor `pg`.

```ts
DatabaseModule.forRoot({
  connectionString: config.DATABASE_URL,
  schema,
  applicationName: 'task-service',
  idempotency: true,
});
```

| Option                | Default  | Effect                                                                            |
| --------------------- | -------- | --------------------------------------------------------------------------------- |
| `connectionString`    | Required | Connection string of the application role (`databaseConfigShape`: `DATABASE_URL`) |
| `schema`              | None     | Drizzle schema of the service, for its relational queries                         |
| `poolSize`            | 5        | Maximum number of connections                                                     |
| `connectionTimeoutMs` | 5000     | How long a transaction waits for a free connection                                |
| `applicationName`     | Unset    | Name shown in `pg_stat_activity`                                                  |
| `idempotency`         | `false`  | Registers the `Idempotency-Key` interceptor                                       |

The module is global. It provides `TenantTransactionRunner`, `SystemTransactionRunner` and the
pool (`DATABASE_POOL`), and closes the pool when the application shuts down.

### Transaction runners

Nothing else opens a transaction. A unit of work is one call to `run`:

```ts
await this.tenant.run(async (tx) => {
  const tasks = new DrizzleTaskRepository(tx.db);
  // tx.client.query(text, values) runs raw SQL on the same connection.
});
```

| Runner                    | For                                                                                                            | Sets, for the transaction only                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `TenantTransactionRunner` | A use case acting for one organization                                                                         | `app.organization_id` = the organization of the context |
| `SystemTransactionRunner` | Work that crosses organizations or has none: outbox relay, schedules, events or routes without an organization | `app.system_access` = `on`                              |

- The tenant runner takes the organization from the organization context, never from an argument.
  It throws when there is none or when its id is not a UUID.
- The work commits when it resolves and rolls back when it rejects. A connection whose rollback
  fails is discarded.
- A `run` called inside a transaction of the same kind (and, for a tenant, the same organization)
  joins it. Starting a system transaction inside a tenant one, or the reverse, throws: a use case
  never changes its own access.
- `run(work, { isolationLevel, readOnly })`: `read committed` and read-write by default. A joined
  transaction must already be at least as strict as what the nested `run` asks: otherwise it
  throws rather than drop the guarantee.
- `tx.db` is the Drizzle database without `transaction`: on one connection Drizzle would issue its
  own `COMMIT` and end the transaction of the runner. Type a repository with
  `TransactionDatabase<typeof schema>`.
- A scope dies with its transaction: its `client` and `db` then reject, and a `run` started by
  work that outlived the transaction opens a new one.
- When the work swallowed the error of a failed statement, PostgreSQL rolls back at `COMMIT`: the
  runner throws `TransactionAbortedError` instead of reporting a success.
- A connection lost during a transaction rejects the work and is discarded; it does not crash the
  process. The pool enables TCP keep-alive. `statement_timeout`, `lock_timeout` and
  `idle_in_transaction_session_timeout` are set per role, by cadenway-ops.
- The system runner removes the filter: every query of a system transaction names the rows it
  means. Never use it to serve the request of a user.

### Row-level security

Two PostgreSQL roles per service: `<svc>_migrator` owns the tables and runs the migrations;
`<svc>_app` runs the service, holds no DDL right and is subject to the policies. Every table with
an `organization_id uuid` column declares the policy of the kit:

```ts
pgTable('tasks', {/* columns */}, () => [organizationPolicy()]);
```

The policy is named `organization_isolation` unless `organizationPolicy(name)` is given another
name. Its predicate, also exported as `organizationIsolation`:

```sql
organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
or current_setting('app.system_access', true) = 'on'
```

With neither parameter set, as on a connection used outside the runners, no row matches. Drizzle
enables row-level security on a table that declares a policy; **forcing it is one more statement
in the migration** (`ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;`), which drizzle-kit does not
generate. Row-level security is the second barrier: a query still filters on `organization_id`.

### Idempotency-Key

With `idempotency: true`, a route marked with `@Idempotent()` honours the `Idempotency-Key`
header. The key and the response are stored in the service's own database, in the same transaction
as the use case: the stored response exists if and only if the effect was committed.

| Situation                                         | Answer                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| First request with a key                          | The handler runs; its response is stored                                                         |
| Same key, same request, within 24 hours           | The stored response, with `Idempotent-Replayed: true`; the handler does not run                  |
| Same key, another method, path or body            | 422 `idempotency.key-reused`                                                                     |
| Same key while the first request is still running | 409 `idempotency.in-progress`                                                                    |
| Handler fails                                     | Its error; nothing is stored and a retry runs again                                              |
| No header                                         | The handler runs normally; 400 `idempotency.key-required` with `@Idempotent({ required: true })` |
| Malformed key                                     | 400 `idempotency.key-invalid` (1 to 255 printable ASCII characters)                              |

What a marked route must respect:

- The interceptor opens the transaction and runs the handler inside it; the `run` of the use case
  joins it. The handler must therefore not call another service before the use case.
- The replayed status is the one NestJS applies from `@HttpCode()` or its default (201 for `POST`),
  not a manual `response.status()`. The `Location` header is stored and replayed; `ETag` is derived
  again from the replayed body.
- `@Idempotent({ isolationLevel })` opens the transaction at that level, for a use case that
  needs more than `read committed`.
- A key belongs to the organization of the verified token, and a stored response to the actor
  that obtained it: the same key sent by another member answers 422. Requests without an organization share
  one namespace and are served in a system transaction: their keys must be unguessable, as a UUID
  is.
- Expired keys are overwritten when used again, never deleted by the interceptor. Schedule
  `purgeExpiredIdempotencyKeys(tx)` in a system transaction.

### Getting the kit tables into the migrations of a service

`drizzle.config.ts` of a service reads `src/modules/*/infrastructure/persistence/*.schema.ts`. A
table of the kit enters the migrations of the service by being re-exported from one such file:

```ts
// src/modules/<module>/infrastructure/persistence/kit.schema.ts
export { idempotencyKeys } from '@cadenway/nest-common/database';
```

`pnpm migration:generate` then writes the table, its unique constraint, its index, `ENABLE ROW
LEVEL SECURITY` and its policy into the service's own migration history (checked with drizzle-kit
against a packed install). Add `ALTER TABLE "idempotency_keys" FORCE ROW LEVEL SECURITY;` to that
migration. When a later version of the kit changes a table, upgrading the package and generating
again produces the migration of the change; the changeset of that version says so for every
service.

## Health module

`HealthModule` adds two routes, built on `@nestjs/terminus`. They are exempt from the internal
token.

| Route               | Purpose                                             | Answer                                |
| ------------------- | --------------------------------------------------- | ------------------------------------- |
| `GET /health/live`  | The process is running. Checks nothing, on purpose. | 200 and the Terminus body             |
| `GET /health/ready` | The application accepts requests.                   | 200, or 503 when a dependency is down |

Imported as the bare class, the module takes no option and readiness answers 200 as soon as the
application listens: `{ "status": "ok", "info": {}, "error": {}, "details": {} }`.

```ts
@Module({ imports: [HealthModule] })
export class AppModule {}
```

`HealthModule.forRoot({ indicators })` makes readiness check the dependencies of the application.
`forRootAsync` builds the indicators from injected providers, which must be visible globally, as
those of `DatabaseModule` are:

```ts
HealthModule.forRootAsync({
  inject: [DATABASE_POOL],
  useFactory: (pool: Pool) => ({ indicators: [postgresIndicator(pool)] }),
});
```

| Indicator                          | Checks                                                                |
| ---------------------------------- | --------------------------------------------------------------------- |
| `postgresIndicator(pool, name?)`   | `select 1` through the `pg` pool; key `postgres`                      |
| `redisIndicator(client, name?)`    | `PING` on an `ioredis` client; key `redis`                            |
| `natsIndicator(connection, name?)` | The connection is open and `flush()` makes the round trip; key `nats` |
| `{ name, check() }`                | Any other dependency: `check` resolves when it answers                |

The indicators take structural types, so this package depends on no driver. The NATS connection
is handed over by `@cadenway/nest-messaging`, which owns it.

| Option       | Default | Effect                                                       |
| ------------ | ------- | ------------------------------------------------------------ |
| `indicators` | `[]`    | Dependencies readiness checks                                |
| `timeoutMs`  | 1000    | Time one check may take before the dependency counts as down |

When a dependency is down, readiness answers 503 with the Terminus body, not a problem, because
orchestrators and dashboards read it:

```json
{
  "status": "error",
  "info": { "postgres": { "status": "up" } },
  "error": { "redis": { "status": "down", "message": "unreachable" } },
  "details": {
    "postgres": { "status": "up" },
    "redis": { "status": "down", "message": "unreachable" }
  }
}
```

`message` is `unreachable` or `timeout`: the body names dependencies and their state, never an
address or an error text. Liveness never runs an indicator: a dependency that is down must not get
a healthy process restarted.
