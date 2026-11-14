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
  baseConfigShape,
  type BaseConfig,
  type ConfigShape,
  type LogLevel,
  type RuntimeEnvironment,
} from './config/base-config.js';
export { CONFIG, ConfigModule, type ConfigModuleOptions } from './config/config.module.js';
export { ConfigError, loadConfig, type ConfigEnvironment } from './config/load-config.js';
export { HealthModule } from './health/health.module.js';
export { routePatternOf } from './http/route.js';
export {
  createLoggerParams,
  LoggingModule,
  type LoggingModuleOptions,
} from './logging/logging.module.js';
export { DEFAULT_REDACTED_KEYS, maskEmails, REDACTED } from './logging/redaction.js';
export { REQUEST_ID_HEADER, requestIdOf, resolveRequestId } from './logging/request-id.js';
export { nameHttpSpan, RouteNameInterceptor } from './telemetry/route-name.interceptor.js';
export { shutdownTelemetry } from './telemetry/telemetry-handle.js';
export { InjectPinoLogger, Logger, PinoLogger } from 'nestjs-pino';
