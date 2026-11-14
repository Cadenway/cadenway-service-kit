import type { DynamicModule, Type } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import type pino from 'pino';

import {
  InternalTokenModule,
  type InternalTokenModuleOptions,
} from '../auth/internal-token.module.js';
import type { BaseConfig } from '../config/base-config.js';
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
   * Verifier and signer options of the internal token. Defaults to none: no route requires a
   * token and no signer exists, which is what an application gets before it is configured.
   *
   * @type {InternalTokenModuleOptions | undefined}
   * @readonly
   */
  readonly internalToken?: InternalTokenModuleOptions;

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
  // #endregion
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
 * - the internal token guard and the organization context, when `internalToken.verifier` is given;
 * - the JSON body limit and the request deadline;
 * - shutdown hooks, with telemetry flushed last.
 *
 * It does not listen: the caller calls `app.listen(port)`. It imports no health or database
 * module either: the module of the application declares what it depends on.
 *
 * @param {Type<unknown>} applicationModule - Root module of the application.
 * @param {CreateApplicationOptions} options - Identity of the application and optional settings.
 * @returns {Promise<NestExpressApplication>} The application, ready to listen.
 */
export async function createApplication(
  applicationModule: Type<unknown>,
  options: CreateApplicationOptions,
): Promise<NestExpressApplication> {
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
      applicationModule,
    ],
    providers: [
      { provide: APP_FILTER, useClass: ProblemFilter },
      { provide: APP_PIPE, useValue: new ZodValidationPipe() },
      { provide: APP_INTERCEPTOR, useClass: RouteNameInterceptor },
      { provide: APP_INTERCEPTOR, useClass: EtagInterceptor },
    ],
  };
  const app: NestExpressApplication = await NestFactory.create<NestExpressApplication>(root, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  applyJsonBodyLimit(app, options.jsonBodyLimitBytes ?? JSON_BODY_LIMIT_BYTES);
  app.use(
    requestDeadlineMiddleware({ budgetMs: options.requestBudgetMs ?? DEFAULT_REQUEST_BUDGET_MS }),
  );
  // The deployment starts the new version next to the old one, then stops the old one: the stop
  // must close open connections instead of cutting them.
  app.enableShutdownHooks();
  return app;
}
