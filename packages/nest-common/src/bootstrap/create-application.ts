import { Logger as NestLogger, type DynamicModule, type Type } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import type pino from 'pino';

import { OrganizationContextInterceptor } from '../auth/context/organization-context.interceptor.js';
import {
  InternalTokenModule,
  type InternalTokenModuleOptions,
} from '../auth/internal-token/internal-token.module.js';
import type { BaseConfig } from '../config/base-config.js';
import { ConfigModule } from '../config/config.module.js';
import { EtagInterceptor } from '../concurrency/etag.js';
import {
  DEFAULT_REQUEST_BUDGET_MS,
  requestDeadlineMiddleware,
} from '../http-client/request-deadline.js';
import { applyJsonBodyLimit, JSON_BODY_LIMIT_BYTES } from '../http/body-limit.js';
import { LoggingModule } from '../logging/logging.module.js';
import { ProblemFilter } from '../problem/problem.filter.js';
import { RouteNameInterceptor } from '../telemetry/route-name.interceptor.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import { ApplicationRootModule } from './application-root.module.js';
import { readPackageVersion } from './package-version.js';

/**
 * Interface CreateApplicationOptions
 *
 * @description
 * Options of `createApplication`. Only `service` is required.
 */
export interface CreateApplicationOptions {
  // #region Properties
  /**
   * Property service
   *
   * @description
   * Name of the service or gateway, such as `task-service`.
   *
   * @type {string}
   * @readonly
   */
  readonly service: string;

  /**
   * Property version
   *
   * @description
   * Released version of the application. Defaults to the version of the `package.json` in the
   * working directory.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly version?: string;

  /**
   * Property config
   *
   * @description
   * Validated configuration, read for `LOG_LEVEL`, `LOG_PRETTY` and `NODE_ENV`. Defaults to
   * `info`, JSON lines and `production`.
   *
   * @type {Partial<Pick<BaseConfig, 'LOG_LEVEL' | 'LOG_PRETTY' | 'NODE_ENV'>> | undefined}
   * @readonly
   */
  readonly config?: Partial<Pick<BaseConfig, 'LOG_LEVEL' | 'LOG_PRETTY' | 'NODE_ENV'>>;

  /**
   * Property internalToken
   *
   * @description
   * Verifier and signer options of the internal token. A service gives `verifier`; an
   * application that calls others gives `signer`.
   *
   * @type {InternalTokenModuleOptions | undefined}
   * @readonly
   */
  readonly internalToken?: InternalTokenModuleOptions;

  /**
   * Property internalTokenVerification
   *
   * @description
   * Whether every route must carry a verified internal token. Defaults to `required`:
   * `createApplication` then throws when `internalToken.verifier` is missing, so a service
   * cannot start with open routes by omission. A public gateway, which authenticates its callers
   * itself, sets `off`.
   *
   * @type {'required' | 'off' | undefined}
   * @readonly
   */
  readonly internalTokenVerification?: 'required' | 'off';

  /**
   * Property acceptIncomingRequestTimeout
   *
   * @description
   * Lets the caller shorten the request budget with `X-Request-Timeout-Ms`. Defaults to
   * `true`; a public edge sets it to `false`.
   *
   * @type {boolean | undefined}
   * @readonly
   */
  readonly acceptIncomingRequestTimeout?: boolean;

  /**
   * Property requestBudgetMs
   *
   * @description
   * Time a request may take, bounding its calls to other services. Defaults to 10 000.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly requestBudgetMs?: number;

  /**
   * Property jsonBodyLimitBytes
   *
   * @description
   * Largest JSON request body accepted. Defaults to 1 048 576 (1 MB).
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly jsonBodyLimitBytes?: number;

  /**
   * Property acceptIncomingRequestId
   *
   * @description
   * Keeps a well-formed `X-Request-Id` sent by the caller. Defaults to `true`.
   *
   * @type {boolean | undefined}
   * @readonly
   */
  readonly acceptIncomingRequestId?: boolean;

  /**
   * Property logDestination
   *
   * @description
   * Stream that receives the log lines. Defaults to the standard output; meant for tests.
   *
   * @type {pino.DestinationStream | undefined}
   * @readonly
   */
  readonly logDestination?: pino.DestinationStream;

  /**
   * Property provideConfig
   *
   * @description
   * Provides `config` globally under the `CONFIG` token, so the application module injects the
   * configuration `main.ts` already validated instead of importing `ConfigModule.forRoot`, which
   * would read and validate the environment a second time. Defaults to `false`. With `true`,
   * `config` must be the complete result of `loadConfig`, and the application module must not
   * import `ConfigModule` itself.
   *
   * @type {boolean | undefined}
   * @readonly
   */
  readonly provideConfig?: boolean;
  // #endregion
}

/**
 * Function configToProvide
 *
 * @description
 * Returns the configuration `provideConfig` registers.
 *
 * @param {CreateApplicationOptions} options - Options of `createApplication`.
 * @returns {Readonly<object>} The validated configuration.
 * @throws {Error} When `provideConfig` is set without `config`.
 */
function configToProvide(options: CreateApplicationOptions): Readonly<object> {
  if (options.config === undefined) {
    throw new Error(
      'createApplication: provideConfig needs the validated configuration in config.',
    );
  }
  return options.config;
}

/**
 * Function silenceNestLogger
 *
 * @description
 * Drops the NestJS lines buffered while a failed application was being created, and keeps the
 * static NestJS logger silent afterwards. The caller reports the error as one structured line
 * (`runApplication`); NestJS would otherwise print the buffered lines, and those its other
 * modules still write while the creation unwinds, through its console logger. The next
 * application created in the same process, such as the next test, installs its own logger.
 *
 * @returns {void}
 */
function silenceNestLogger(): void {
  NestLogger.overrideLogger(false);
  NestLogger.flush();
}

/**
 * Function createApplication
 *
 * @description
 * Creates the NestJS application of a Cadenway backend with every shared format applied, so a
 * `main.ts` stays a few lines:
 *
 * - structured logs (`LoggingModule`) and the NestJS logger routed to them;
 * - `ProblemFilter` for every error, `ZodValidationPipe` for `zodDto` parameters;
 * - `RouteNameInterceptor` and `EtagInterceptor`;
 * - the internal token guard, required unless `internalTokenVerification` is `off`;
 * - `OrganizationContextInterceptor` in every case: it opens the context of the verified
 *   internal token, or the one attached with `setRequestOrganizationContext` by an application
 *   that verifies its callers itself, and does nothing for a request with neither;
 * - the JSON body limit and the request deadline;
 * - no `X-Powered-By` header;
 * - shutdown hooks, with telemetry flushed after the application closed its own resources.
 *
 * It does not listen: the caller calls `app.listen(port)`. It imports no health or database
 * module either: the module of the application declares what it depends on.
 *
 * An error while the application is created (an invalid configuration read by a provider, a
 * failing provider factory) rejects the returned promise: NestJS neither prints it with its
 * console logger nor aborts the process, so `runApplication` can write it as one structured line.
 *
 * @param {Type<unknown> | DynamicModule} applicationModule - Root module of the application, as a class or a dynamic module.
 * @param {CreateApplicationOptions} options - Identity of the application and optional settings.
 * @returns {Promise<NestExpressApplication>} The application, ready to listen.
 * @throws {Error} When no internal token verifier is configured and verification was not turned off, when `provideConfig` is set without `config`, or when a provider fails while the application is created.
 */
export async function createApplication(
  applicationModule: Type<unknown> | DynamicModule,
  options: CreateApplicationOptions,
): Promise<NestExpressApplication> {
  if (
    (options.internalTokenVerification ?? 'required') === 'required' &&
    options.internalToken?.verifier === undefined
  ) {
    throw new Error(
      'createApplication: internalToken.verifier is required. Set internalTokenVerification to "off" only for an application that authenticates its callers itself.',
    );
  }
  const root: DynamicModule = {
    module: ApplicationRootModule,
    imports: [
      LoggingModule.forRoot({
        service: options.service,
        version: options.version ?? readPackageVersion(),
        ...(options.config?.LOG_LEVEL === undefined ? {} : { level: options.config.LOG_LEVEL }),
        ...(options.config?.LOG_PRETTY === undefined ? {} : { pretty: options.config.LOG_PRETTY }),
        ...(options.config?.NODE_ENV === undefined ? {} : { environment: options.config.NODE_ENV }),
        ...(options.acceptIncomingRequestId === undefined
          ? {}
          : { acceptIncomingRequestId: options.acceptIncomingRequestId }),
        ...(options.logDestination === undefined ? {} : { destination: options.logDestination }),
      }),
      ...(options.internalToken === undefined
        ? []
        : [InternalTokenModule.forRoot(options.internalToken)]),
      ...(options.provideConfig === true ? [ConfigModule.forValue(configToProvide(options))] : []),
      applicationModule,
    ],
    // Global interceptors run in the order they are registered, the first outermost. The
    // providers of this root module come before those of any imported module, so the
    // organization context opened here wraps the handler and the `Idempotency-Key`
    // interceptor of `DatabaseModule`.
    providers: [
      { provide: APP_FILTER, useClass: ProblemFilter },
      { provide: APP_PIPE, useValue: new ZodValidationPipe() },
      { provide: APP_INTERCEPTOR, useClass: RouteNameInterceptor },
      { provide: APP_INTERCEPTOR, useClass: EtagInterceptor },
      { provide: APP_INTERCEPTOR, useClass: OrganizationContextInterceptor },
    ],
  };
  let app: NestExpressApplication;
  try {
    app = await NestFactory.create<NestExpressApplication>(root, {
      bufferLogs: true,
      // The lines buffered before the structured logger exists are flushed below, through it;
      // when creation fails they are dropped instead of printed by the NestJS console logger.
      autoFlushLogs: false,
      // NestJS would otherwise log the error with its console logger and abort the process.
      abortOnError: false,
    });
  } catch (error) {
    silenceNestLogger();
    throw error;
  }
  app.useLogger(app.get(Logger));
  app.flushLogs();
  // Express announces itself by default; the header tells a scanner what to try.
  app.disable('x-powered-by');
  applyJsonBodyLimit(app, options.jsonBodyLimitBytes ?? JSON_BODY_LIMIT_BYTES);
  app.use(
    requestDeadlineMiddleware({
      budgetMs: options.requestBudgetMs ?? DEFAULT_REQUEST_BUDGET_MS,
      ...(options.acceptIncomingRequestTimeout === undefined
        ? {}
        : { acceptIncoming: options.acceptIncomingRequestTimeout }),
    }),
  );
  // The deployment starts the new version next to the old one, then stops the old one: the stop
  // must close open connections instead of cutting them.
  app.enableShutdownHooks();
  return app;
}
