import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { Module, type DynamicModule } from '@nestjs/common';
import { trace, type SpanContext } from '@opentelemetry/api';
import { LoggerModule, type Params } from 'nestjs-pino';
import pino from 'pino';
import type { Options } from 'pino-http';

import { requestOrganizationContextOf } from '../auth/context/request-organization-context.js';
import {
  getOrganizationContext,
  type OrganizationContext,
} from '../auth/context/organization-context.js';
import type { LogLevel, RuntimeEnvironment } from '../config/base-config.js';
import { readPackageVersion } from '../bootstrap/application/package-version.js';
import {
  redactedKeySet,
  sanitizeHttpField,
  sanitizeLogArguments,
  sanitizeLogFields,
  sanitizeSerializedError,
} from './redaction.js';
import { routePatternOf } from '../http/routing/route.js';
import { REQUEST_ID_HEADER, resolveRequestId } from './request-id.js';

/**
 * Interface LoggingModuleOptions
 *
 * @description
 * Options of `LoggingModule.forRoot`.
 */
export interface LoggingModuleOptions {
  // #region Properties
  /**
   * Property service
   *
   * @description
   * Name of the service or gateway, written in the `service` field of every line.
   *
   * @type {string}
   * @readonly
   */
  readonly service: string;

  /**
   * Property version
   *
   * @description
   * Released version of the application, written in the `version` field of every line.
   * Defaults to the version of the `package.json` in the working directory.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly version?: string;

  /**
   * Property level
   *
   * @description
   * Minimum level written, usually `LOG_LEVEL`. Defaults to `info`.
   *
   * @type {LogLevel | undefined}
   * @readonly
   */
  readonly level?: LogLevel;

  /**
   * Property pretty
   *
   * @description
   * Writes through the `pino-pretty` development transport, resolved from the application's own
   * dependencies. Defaults to `false`: one JSON line per event.
   *
   * @type {boolean | undefined}
   * @readonly
   */
  readonly pretty?: boolean;

  /**
   * Property environment
   *
   * @description
   * Runtime environment, usually `NODE_ENV`. Defaults to `production`, where `pretty` is refused.
   *
   * @type {RuntimeEnvironment | undefined}
   * @readonly
   */
  readonly environment?: RuntimeEnvironment;

  /**
   * Property redactKeys
   *
   * @description
   * Keys masked in addition to `DEFAULT_REDACTED_KEYS`. The defaults cannot be removed.
   *
   * @type {readonly string[] | undefined}
   * @readonly
   */
  readonly redactKeys?: readonly string[];

  /**
   * Property acceptIncomingRequestId
   *
   * @description
   * Keeps a well-formed `X-Request-Id` sent by the caller. Defaults to `true`, which lets a
   * service continue the id of its gateway; a public edge may set it to `false`.
   *
   * @type {boolean | undefined}
   * @readonly
   */
  readonly acceptIncomingRequestId?: boolean;

  /**
   * Property destination
   *
   * @description
   * Stream that receives the lines. Defaults to the standard output; ignored when `pretty` is
   * set. Meant for tests.
   *
   * @type {pino.DestinationStream | undefined}
   * @readonly
   */
  readonly destination?: pino.DestinationStream;
  // #endregion
}

/**
 * Constant HEALTH_PATH_PREFIX
 *
 * @description
 * Path prefix of the probe routes, which are not logged: a probe every few seconds would bury
 * the real traffic.
 *
 * @type {string}
 */
const HEALTH_PATH_PREFIX: string = '/health/';

/**
 * Function identityFields
 *
 * @description
 * Builds the fields naming who a line is written for. Identifiers only: never a name or an
 * e-mail address.
 *
 * @param {OrganizationContext | undefined} context - Organization context of the work, if any.
 * @returns {Record<string, unknown>} `organizationId` and, for a user, `userId`.
 */
function identityFields(context: OrganizationContext | undefined): Record<string, unknown> {
  if (context === undefined) {
    return {};
  }
  return {
    ...(context.organizationId === null ? {} : { organizationId: context.organizationId }),
    ...(context.actor.type === 'user' && context.actor.id !== null
      ? { userId: context.actor.id }
      : {}),
  };
}

/**
 * Function completionFields
 *
 * @description
 * Builds the fields of the line written when a request completes.
 *
 * @param {IncomingMessage} request - Request that just completed.
 * @param {ServerResponse} response - Its response.
 * @param {unknown} durationMs - Time spent handling it, in milliseconds.
 * @returns {Record<string, unknown>} The `method`, `route`, `status`, `durationMs` and identity fields.
 */
function completionFields(
  request: IncomingMessage,
  response: ServerResponse,
  durationMs: unknown,
): Record<string, unknown> {
  return {
    method: request.method,
    route: routePatternOf(request),
    status: response.statusCode,
    durationMs,
    ...identityFields(requestOrganizationContextOf(request)),
  };
}

/**
 * Function contextFields
 *
 * @description
 * Reads what joins a line to its trace and to who it is written for: the identifiers of the
 * active OpenTelemetry span and of the current organization context.
 *
 * @returns {Record<string, unknown>} `traceId`, `spanId`, `organizationId` and `userId`, each when known.
 */
function contextFields(): Record<string, unknown> {
  const span: SpanContext | undefined = trace.getActiveSpan()?.spanContext();
  return {
    ...(span === undefined ? {} : { traceId: span.traceId, spanId: span.spanId }),
    ...identityFields(getOrganizationContext()),
  };
}

/**
 * Function prettyTransport
 *
 * @description
 * Resolves the `pino-pretty` transport from the application's own dependencies: it is a
 * development dependency of the application, never one of this package.
 *
 * @param {RuntimeEnvironment} environment - Runtime environment of the process.
 * @returns {pino.TransportSingleOptions} The transport configuration.
 * @throws {Error} In production, or when the application does not install `pino-pretty`.
 */
function prettyTransport(environment: RuntimeEnvironment): pino.TransportSingleOptions {
  if (environment === 'production') {
    throw new Error('Pretty logs are a development transport: refused when NODE_ENV=production.');
  }
  try {
    const target: string = createRequire(join(process.cwd(), 'package.json')).resolve(
      'pino-pretty',
    );
    return { target };
  } catch {
    throw new Error('Pretty logs need pino-pretty in the devDependencies of the application.');
  }
}

/**
 * Interface BindingMethods
 *
 * @description
 * The methods of pino's logger prototype that bind fields to a logger, typed without the custom
 * levels generics of `pino.Logger` so the originals can be called on any derived logger.
 */
interface BindingMethods {
  // #region Properties
  /**
   * Property child
   *
   * @description
   * Pino's `child()`: creates a logger that writes the bindings on every line.
   *
   * @type {(this: pino.Logger, bindings: pino.Bindings, options?: pino.ChildLoggerOptions) => pino.Logger}
   * @readonly
   */
  readonly child: (
    this: pino.Logger,
    bindings: pino.Bindings,
    options?: pino.ChildLoggerOptions,
  ) => pino.Logger;

  /**
   * Property setBindings
   *
   * @description
   * Pino's `setBindings()`: adds bindings to an existing logger.
   *
   * @type {(this: pino.Logger, bindings: pino.Bindings) => void}
   * @readonly
   */
  readonly setBindings: (this: pino.Logger, bindings: pino.Bindings) => void;
  // #endregion
}

/**
 * Function withSanitizedBindings
 *
 * @description
 * Makes `child()` and `setBindings()` sanitize their bindings as the `log` formatter sanitizes
 * the fields of a line. Pino writes bindings without calling that formatter: it serializes them
 * once, when they are bound. The two methods are set on the root logger, so every logger derived
 * from it inherits them: the logger of pino-http, the request logger of each request, the
 * children `assign()` and `runInContext()` of `PinoLogger` create, and their own children.
 *
 * @param {pino.Logger} root - Root logger of the application.
 * @param {ReadonlySet<string>} keys - Normalized keys to mask, from `redactedKeySet`.
 * @returns {pino.Logger} The same logger.
 */
function withSanitizedBindings(root: pino.Logger, keys: ReadonlySet<string>): pino.Logger {
  const { child, setBindings } = Object.getPrototypeOf(root) as BindingMethods;
  // A missing binding object is passed on as is, for pino to refuse it with its own error.
  const sanitize = (bindings: unknown): pino.Bindings =>
    typeof bindings === 'object' && bindings !== null
      ? sanitizeLogFields(bindings as Record<string, unknown>, keys)
      : (bindings as pino.Bindings);
  return Object.defineProperties(root, {
    child: {
      configurable: true,
      writable: true,
      value(this: pino.Logger, bindings: unknown, options?: pino.ChildLoggerOptions): pino.Logger {
        return child.call(this, sanitize(bindings), options);
      },
    },
    setBindings: {
      configurable: true,
      writable: true,
      value(this: pino.Logger, bindings: unknown): void {
        setBindings.call(this, sanitize(bindings));
      },
    },
  });
}

/**
 * Function createLoggerParams
 *
 * @description
 * Builds the `nestjs-pino` parameters shared by every Cadenway backend: one JSON line per event
 * with `service`, `version`, `traceId`, `spanId`, `requestId`, `organizationId` and `userId`; one
 * completion line per request with `method`, `route`, `status` and `durationMs`; default redaction; no request body, header,
 * query string or address.
 *
 * Redaction covers every way a value reaches a line: the `log` formatter sanitizes the fields of
 * the line, the serializers its `err`, `req` and `res` fields, the `logMethod` hook the message
 * and what is interpolated into it, and the root logger the bindings of every derived logger.
 * The root logger is built here and handed to pino-http as its parent: pino-http would otherwise
 * build it out of reach.
 *
 * @param {LoggingModuleOptions} options - Options of the logging module.
 * @returns {Params} The `nestjs-pino` parameters.
 * @throws {Error} When pretty logs are asked for in production or without `pino-pretty`.
 */
export function createLoggerParams(options: LoggingModuleOptions): Params {
  const acceptIncoming: boolean = options.acceptIncomingRequestId ?? true;
  const redactedKeys: ReadonlySet<string> = redactedKeySet(options.redactKeys);
  const transport: pino.TransportSingleOptions | undefined =
    options.pretty === true ? prettyTransport(options.environment ?? 'production') : undefined;
  const serializers: Record<string, pino.SerializerFn> = {
    // pino-http already serializes errors and retains the original on `raw`.
    err: (error: unknown) =>
      sanitizeSerializedError(
        error instanceof Error ? pino.stdSerializers.err(error) : error,
        redactedKeys,
      ),
    req: (value: unknown) => sanitizeHttpField(value, redactedKeys),
    res: (value: unknown) => sanitizeHttpField(value, redactedKeys),
  };
  const loggerOptions: pino.LoggerOptions = {
    level: options.level ?? 'info',
    base: { service: options.service, version: options.version ?? readPackageVersion() },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label: string) => ({ level: label }),
      log: (object: Record<string, unknown>) => sanitizeLogFields(object, redactedKeys),
    },
    mixin: contextFields,
    hooks: {
      logMethod(args: Parameters<pino.LogFn>, method: pino.LogFn): void {
        method.apply(this, sanitizeLogArguments(args, redactedKeys) as Parameters<pino.LogFn>);
      },
    },
    serializers,
    ...(transport === undefined ? {} : { transport }),
  };
  const root: pino.Logger = withSanitizedBindings(
    transport !== undefined || options.destination === undefined
      ? pino(loggerOptions)
      : pino(loggerOptions, options.destination),
    redactedKeys,
  );
  const httpOptions: Options = {
    logger: root,
    // pino-http wraps the serializers it is given around pino's standard ones and sets them on
    // its logger, over those of the root: without them, its standard ones would apply.
    serializers,
    genReqId: (request: IncomingMessage, response: ServerResponse) => {
      const id: string = resolveRequestId(request.headers['x-request-id'], acceptIncoming);
      response.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },
    customAttributeKeys: { reqId: 'requestId', responseTime: 'durationMs' },
    // The request-scoped logger carries the request id only: the default one would attach the
    // whole request, with its headers, query string and remote address.
    quietReqLogger: true,
    quietResLogger: true,
    autoLogging: {
      ignore: (request: IncomingMessage) => (request.url ?? '').startsWith(HEALTH_PATH_PREFIX),
    },
    customLogLevel: (_request: IncomingMessage, response: ServerResponse, error?: Error) => {
      if (error !== undefined || response.statusCode >= 500) {
        return 'error';
      }
      return response.statusCode >= 400 ? 'warn' : 'info';
    },
    customSuccessMessage: () => 'request completed',
    customErrorMessage: () => 'request failed',
    customSuccessObject: (
      request: IncomingMessage,
      response: ServerResponse,
      value: { durationMs?: unknown },
    ) => completionFields(request, response, value.durationMs),
    customErrorObject: (
      request: IncomingMessage,
      response: ServerResponse,
      error: Error,
      value: { durationMs?: unknown },
    ) => ({ ...completionFields(request, response, value.durationMs), err: error }),
  };
  return { pinoHttp: httpOptions };
}

/**
 * Class LoggingModule
 *
 * @description
 * Installs the structured logs of a Cadenway backend, through `nestjs-pino`.
 *
 * An application imports `LoggingModule.forRoot(...)` (or lets the bootstrap helper do it) and
 * never configures pino itself. Inject `Logger` or `PinoLogger`, re-exported by this package, to
 * write a line.
 */
@Module({})
export class LoggingModule {
  // #region Methods
  /**
   * Method forRoot
   *
   * @description
   * Configures the logger and the request logging middleware for the whole application.
   *
   * @param {LoggingModuleOptions} options - Service identity, level and development options.
   * @returns {DynamicModule} The module to import in the application module.
   * @throws {Error} When pretty logs are asked for in production or without `pino-pretty`.
   */
  public static forRoot(options: LoggingModuleOptions): DynamicModule {
    return {
      module: LoggingModule,
      imports: [LoggerModule.forRoot(createLoggerParams(options))],
      exports: [LoggerModule],
    };
  }
  // #endregion
}
