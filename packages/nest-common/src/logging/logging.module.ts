import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { Module, type DynamicModule } from '@nestjs/common';
import { trace, type SpanContext } from '@opentelemetry/api';
import { LoggerModule, type Params } from 'nestjs-pino';
import pino from 'pino';
import type { Options } from 'pino-http';

import { requestOrganizationContextOf } from '../auth/internal-token.guard.js';
import { getOrganizationContext, type OrganizationContext } from '../auth/organization-context.js';
import type { LogLevel, RuntimeEnvironment } from '../config/base-config.js';
import { readPackageVersion } from '../bootstrap/package-version.js';
import {
  maskEmails,
  redactedKeySet,
  sanitizeLogValue,
  sanitizeSerializedError,
} from './redaction.js';
import { routePatternOf } from '../http/route.js';
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
 * Function createLoggerParams
 *
 * @description
 * Builds the `nestjs-pino` parameters shared by every Cadenway backend: one JSON line per event
 * with `service`, `version`, `traceId`, `spanId`, `requestId`, `organizationId` and `userId`; one
 * completion line per request with `method`, `route`, `status` and `durationMs`; default redaction; no request body, header,
 * query string or address.
 *
 * @param {LoggingModuleOptions} options - Options of the logging module.
 * @returns {Params} The `nestjs-pino` parameters.
 * @throws {Error} When pretty logs are asked for in production or without `pino-pretty`.
 */
export function createLoggerParams(options: LoggingModuleOptions): Params {
  const acceptIncoming: boolean = options.acceptIncomingRequestId ?? true;
  const redactedKeys: ReadonlySet<string> = redactedKeySet(options.redactKeys);
  const httpOptions: Options = {
    level: options.level ?? 'info',
    base: { service: options.service, version: options.version ?? readPackageVersion() },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label: string) => ({ level: label }),
      log: (object: Record<string, unknown>) =>
        sanitizeLogValue(object, redactedKeys) as Record<string, unknown>,
    },
    mixin: contextFields,
    hooks: {
      logMethod(args: Parameters<pino.LogFn>, method: pino.LogFn): void {
        const masked: unknown[] = args.map((argument: unknown) =>
          typeof argument === 'string' ? maskEmails(argument) : argument,
        );
        method.apply(this, masked as Parameters<pino.LogFn>);
      },
    },
    serializers: {
      err: (error: Error) =>
        sanitizeSerializedError({ ...pino.stdSerializers.err(error) }, redactedKeys),
    },
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
  if (options.pretty === true) {
    return {
      pinoHttp: { ...httpOptions, transport: prettyTransport(options.environment ?? 'production') },
    };
  }
  return {
    pinoHttp: options.destination === undefined ? httpOptions : [httpOptions, options.destination],
  };
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
