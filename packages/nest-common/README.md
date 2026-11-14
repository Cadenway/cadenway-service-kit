# @cadenway/nest-common

Plumbing shared by the Cadenway NestJS services and gateways. Implemented today: typed
configuration, structured logs, OpenTelemetry start-up, the HTTP formats (errors, validation,
pagination, entity tags, body limit) and the health routes. The rest of what the
[repository instructions](../../AGENTS.md) list for this package is not implemented yet.

`@nestjs/common`, `@nestjs/core`, `@opentelemetry/api`, `reflect-metadata`, `rxjs` and `zod` are
peer dependencies: the application provides them.

| Entry point                       | Holds                                                                    |
| --------------------------------- | ------------------------------------------------------------------------ |
| `@cadenway/nest-common`           | Configuration, logs, HTTP formats, route-name interceptor, health module |
| `@cadenway/nest-common/telemetry` | `startTelemetry`, for the preloaded `telemetry.js`                       |
| `@cadenway/nest-common/hook.mjs`  | Module loader of the OpenTelemetry instrumentations, for Node            |

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
`spanId`. Each request writes one completion line, `request completed` or `request failed`, with
`method`, `route` (the matched pattern, `null` when no route matched), `status` and `durationMs`:
`info` below 400, `warn` from 400, `error` from 500.

| Never written                                 | Why                                                                |
| --------------------------------------------- | ------------------------------------------------------------------ |
| Request and response bodies, headers, cookies | The request object is not attached to the lines                    |
| Query strings and raw paths                   | Only the route pattern is logged                                   |
| Remote addresses                              | Same                                                               |
| Probe requests under `/health/`               | A probe every few seconds would bury the traffic                   |
| Values of the redacted keys                   | Replaced by `[REDACTED]` in the first three levels of an object    |
| E-mail addresses in messages and error texts  | Replaced by `[REDACTED]` in every string argument and logged error |

Redacted keys (`DEFAULT_REDACTED_KEYS`): `authorization`, `cookie`, `set-cookie`, `password`,
`currentPassword`, `newPassword`, `token`, `accessToken`, `refreshToken`, `idToken`,
`sessionToken`, `secret`, `clientSecret`, `apiKey`, `privateKey`, `email`. The key-based redaction
covers the root of a logged object and two levels below; a deeper value is not masked, so log
identifiers, not whole payloads.

### Options

| Option                    | Default      | Effect                                                                                                                                           |
| ------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `service`                 | Required     | `service` field                                                                                                                                  |
| `version`                 | Required     | `version` field                                                                                                                                  |
| `level`                   | `info`       | Minimum level written                                                                                                                            |
| `pretty`                  | `false`      | Uses the `pino-pretty` transport of the application's own `devDependencies`; throws when `environment` is `production` or the package is missing |
| `environment`             | `production` | Runtime environment, used to refuse `pretty`                                                                                                     |
| `redactKeys`              | `[]`         | Keys masked in addition to the defaults; the defaults cannot be removed                                                                          |
| `acceptIncomingRequestId` | `true`       | Keeps a well-formed incoming `X-Request-Id` (8 to 128 characters among letters, digits, `.`, `_`, `:`, `-`)                                      |
| `destination`             | stdout       | Stream that receives the lines, for tests; ignored with `pretty`                                                                                 |

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
`http.not-found`, `http.conflict`, `http.precondition-failed`, `http.unprocessable-content`,
`http.too-many-requests`, `http.service-unavailable`, `internal.unexpected`, `request.invalid`,
`request.body-too-large`, `request.invalid-if-match`, `request.if-match-required`,
`precondition.failed` and `pagination.invalid-cursor`.

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
| `decodeCursor(cursor, filters)`    | 400 `pagination.invalid-cursor` for a malformed cursor or one issued for other filters |
| `buildPage(rows, limit, cursorOf)` | Expects `limit + 1` rows; `nextCursor` is `null` on the last page                      |

The cursor is not signed and not secret: it only positions a query that still filters on the
organization of the verified token.

## Entity tags

The `version` of an aggregate is its `ETag`.

| Helper                                                   | Behavior                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `EtagInterceptor`                                        | Sets `ETag: "<version>"` when a handler returns an object with an integer `version`; lists are left alone    |
| `@IfMatch()`                                             | Hands the parsed `If-Match` header to the handler; a malformed header answers 400 `request.invalid-if-match` |
| `assertVersionMatch(condition, currentVersion, options)` | 412 `precondition.failed` when the versions differ. Call it inside the transaction that writes               |
| `formatEtag(version)`, `parseIfMatch(header)`            | The underlying conversions                                                                                   |

`If-Match` is optional by default. With `{ required: true }`, for routes that edit long texts, a
request without the header answers 400 `request.if-match-required` (428 is not a status of the
contract set). A weak tag (`W/"7"`) never matches, as `If-Match` requires a strong comparison.

## Body limit

`applyJsonBodyLimit(app, limitBytes = JSON_BODY_LIMIT_BYTES)` registers the JSON body parser with
a limit of 1 MB (1 048 576 bytes). Call it before the application is initialized. A larger body
answers 400 `request.body-too-large`; a malformed one answers 400 `http.bad-request`.

## Health module

`HealthModule` adds two routes, built on `@nestjs/terminus`:

| Route               | Purpose                                             | Answer                    |
| ------------------- | --------------------------------------------------- | ------------------------- |
| `GET /health/live`  | The process is running. Checks nothing, on purpose. | 200 and the Terminus body |
| `GET /health/ready` | The application accepts requests.                   | 200 and the Terminus body |

The Terminus body of a healthy application is `{ "status": "ok", "info": {}, "error": {}, "details": {} }`.

```ts
import { Module } from '@nestjs/common';
import { HealthModule } from '@cadenway/nest-common';

@Module({ imports: [HealthModule] })
export class AppModule {}
```

### Options

None. Readiness runs no dependency indicator yet: it answers 200 as soon as the application
listens. Indicators are meant to arrive behind an option whose default keeps this behavior, so the
import above stays valid.
