/**
 * Public entry point of `@cadenway/nest-common`: the plumbing shared by the Cadenway NestJS
 * services and gateways. Everything a consumer may import is listed here by name.
 *
 * The OpenTelemetry start-up lives in `@cadenway/nest-common/telemetry`, so the preloaded
 * `telemetry.js` of an application does not import NestJS.
 *
 * @packageDocumentation
 */
export {
  internalTokenSignerConfigShape,
  internalTokenVerifierConfigShape,
  type InternalTokenSignerConfig,
  type InternalTokenVerifierConfig,
} from './auth/internal-token/internal-token.config.js';
export {
  InternalAccess,
  InternalTokenGuard,
  SkipInternalToken,
  type InternalAccessOptions,
} from './auth/internal-token/internal-token.guard.js';
export {
  INTERNAL_TOKEN_ALGORITHM,
  INTERNAL_TOKEN_LIFETIME_SECONDS,
  InternalTokenSigner,
  InternalTokenVerifier,
  type Ed25519PrivateJwk,
  type Ed25519PublicJwk,
  type InternalTokenClaims,
  type InternalTokenSignerOptions,
  type InternalTokenVerifierOptions,
  type InvalidTokenReason,
} from './auth/internal-token/internal-token.js';
export {
  InternalTokenModule,
  type InternalTokenModuleOptions,
} from './auth/internal-token/internal-token.module.js';
export type { InternalPrincipal } from './auth/context/internal-principal.js';
export { OrganizationContextInterceptor } from './auth/context/organization-context.interceptor.js';
export {
  principalOf,
  setRequestOrganizationContext,
} from './auth/context/request-organization-context.js';
export {
  getOrganizationContext,
  requireOrganizationId,
  runWithOrganizationContext,
  type InternalActor,
  type InternalActorType,
  type OrganizationContext,
} from './auth/context/organization-context.js';
export {
  baseConfigShape,
  type BaseConfig,
  type ConfigShape,
  type LogLevel,
  type RuntimeEnvironment,
} from './config/base-config.js';
export {
  createApplication,
  type CreateApplicationOptions,
} from './bootstrap/application/create-application.js';
export { readPackageVersion } from './bootstrap/application/package-version.js';
export {
  runApplication,
  type RunApplicationOptions,
  type StartupErrorStream,
} from './bootstrap/lifecycle/run-application.js';
export {
  assertVersionMatch,
  EtagInterceptor,
  formatEtag,
  IfMatch,
  parseIfMatch,
  type IfMatchCondition,
  type VersionCheckOptions,
} from './http/concurrency/etag.js';
export { CONFIG, ConfigModule, type ConfigModuleOptions } from './config/config.module.js';
export { ConfigError, loadConfig, type ConfigEnvironment } from './config/load-config.js';
export {
  DEFAULT_INDICATOR_TIMEOUT_MS,
  natsIndicator,
  postgresIndicator,
  redisIndicator,
  type HealthIndicator,
  type HealthModuleOptions,
  type NatsProbe,
  type PostgresProbe,
  type RedisProbe,
} from './health/checks/health-indicators.js';
export { HealthModule, type HealthModuleAsyncOptions } from './health/health.module.js';
export {
  InternalHttpClient,
  MAX_CALL_TIMEOUT_MS,
  type InternalHttpClientOptions,
  type InternalRequestInit,
} from './http/client/internal-http-client.js';
export {
  DEFAULT_REQUEST_BUDGET_MS,
  remainingBudgetMs,
  REQUEST_TIMEOUT_HEADER,
  requestDeadlineMiddleware,
  runWithDeadline,
  type RequestDeadlineOptions,
} from './http/deadline/request-deadline.js';
export {
  applyJsonBodyLimit,
  JSON_BODY_LIMIT_BYTES,
  type BodyParserHost,
} from './http/body/body-limit.js';
export { routePatternOf } from './http/routing/route.js';
export { LoggingModule, type LoggingModuleOptions } from './logging/logging.module.js';
export {
  buildPage,
  decodeCursor,
  DEFAULT_PAGE_LIMIT,
  encodeCursor,
  MAX_PAGE_LIMIT,
  pageQueryShape,
  type CursorPosition,
  type CursorValue,
  type Page,
  type PageQuery,
} from './pagination/cursor.js';
export { ProblemFilter, toProblem, WS_EXCEPTION_EVENT } from './problem/problem.filter.js';
export {
  PROBLEM_CONTENT_TYPE,
  ProblemException,
  type Problem,
  type ProblemInit,
  type ProblemStatus,
} from './problem/problem.js';
export { DEFAULT_REDACTED_KEYS, maskEmails, REDACTED } from './logging/redaction.js';
export { REQUEST_ID_HEADER, requestIdOf } from './logging/request-id.js';
export { nameHttpSpan, RouteNameInterceptor } from './telemetry/http/route-name.interceptor.js';
export { shutdownTelemetry } from './telemetry/sdk/telemetry-handle.js';
export {
  zodDto,
  ZodValidationPipe,
  type ValidationIssue,
  type ZodDto,
} from './validation/zod-validation.pipe.js';
export { InjectPinoLogger, Logger, PinoLogger } from 'nestjs-pino';
