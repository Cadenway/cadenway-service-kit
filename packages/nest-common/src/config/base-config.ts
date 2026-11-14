import { z } from 'zod';

/**
 * Type LogLevel
 *
 * @description
 * Levels accepted by `LOG_LEVEL`, from the most to the least verbose.
 *
 * @type {'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent'}
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

/**
 * Type RuntimeEnvironment
 *
 * @description
 * Values accepted by `NODE_ENV`.
 *
 * @type {'development' | 'test' | 'production'}
 */
export type RuntimeEnvironment = 'development' | 'test' | 'production';

/**
 * Interface BaseConfig
 *
 * @description
 * Variables every Cadenway service and gateway reads, as validated by `baseConfigShape`.
 */
export interface BaseConfig {
  // #region Properties
  /**
   * Property NODE_ENV
   *
   * @description
   * Runtime environment. Defaults to `production`, the safe value: development conveniences such
   * as pretty logs must be asked for.
   *
   * @type {RuntimeEnvironment}
   * @readonly
   */
  readonly NODE_ENV: RuntimeEnvironment;

  /**
   * Property PORT
   *
   * @description
   * TCP port of the HTTP API, an integer between 1 and 65535. Required: every image sets it.
   *
   * @type {number}
   * @readonly
   */
  readonly PORT: number;

  /**
   * Property LOG_LEVEL
   *
   * @description
   * Minimum level written to the logs. Defaults to `info`.
   *
   * @type {LogLevel}
   * @readonly
   */
  readonly LOG_LEVEL: LogLevel;

  /**
   * Property LOG_PRETTY
   *
   * @description
   * Asks for the `pino-pretty` development transport. Defaults to `false`, and is refused when
   * `NODE_ENV` is `production`.
   *
   * @type {boolean}
   * @readonly
   */
  readonly LOG_PRETTY: boolean;
  // #endregion
}

/**
 * Type ConfigShape
 *
 * @description
 * Zod shape whose parsed output is the given configuration type. Spread several shapes into one
 * `z.object` to compose the schema of an application.
 *
 * @type {{ readonly [TKey in keyof TConfig]: z.ZodType<TConfig[TKey]> }}
 */
export type ConfigShape<TConfig> = { readonly [TKey in keyof TConfig]: z.ZodType<TConfig[TKey]> };

/**
 * Constant baseConfigShape
 *
 * @description
 * Zod shape of the variables every service and gateway reads. Spread it into the application
 * schema: `z.object({ ...baseConfigShape, DATABASE_URL: z.url() })`.
 *
 * @type {ConfigShape<BaseConfig>}
 */
export const baseConfigShape: ConfigShape<BaseConfig> = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  LOG_PRETTY: z.stringbool().default(false),
};
