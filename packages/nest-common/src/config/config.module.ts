import { Module, type DynamicModule } from '@nestjs/common';
import type { z } from 'zod';

import { loadConfig, type ConfigEnvironment } from './load-config.js';

/**
 * Constant CONFIG
 *
 * @description
 * Injection token of the validated configuration provided by `ConfigModule.forRoot`. Inject it
 * with `@Inject(CONFIG)` and type the parameter with the configuration type of the application.
 *
 * @type {symbol}
 */
export const CONFIG: unique symbol = Symbol('cadenway.config');

/**
 * Interface ConfigModuleOptions
 *
 * @description
 * Options of `ConfigModule.forRoot`.
 */
export interface ConfigModuleOptions<TConfig> {
  // #region Properties
  /**
   * Property schema
   *
   * @description
   * Zod schema of the variables the application reads.
   *
   * @type {z.ZodType<TConfig>}
   * @readonly
   */
  readonly schema: z.ZodType<TConfig>;

  /**
   * Property env
   *
   * @description
   * Environment to validate. Defaults to `process.env`.
   *
   * @type {ConfigEnvironment | undefined}
   * @readonly
   */
  readonly env?: ConfigEnvironment;
  // #endregion
}

/**
 * Class ConfigModule
 *
 * @description
 * Validates the environment once and provides the result under the `CONFIG` token, globally.
 *
 * Validation runs inside `forRoot`, while the application module is being declared: an invalid
 * environment throws a `ConfigError` before NestJS creates anything, so the process never listens
 * with a partial configuration.
 */
@Module({})
export class ConfigModule {
  // #region Methods
  /**
   * Method forRoot
   *
   * @description
   * Validates the environment against the schema and registers the frozen result globally.
   *
   * @param {ConfigModuleOptions<TConfig>} options - Schema and, optionally, the environment to read.
   * @returns {DynamicModule} The global module providing `CONFIG`.
   * @throws {ConfigError} When a variable is missing or invalid.
   */
  public static forRoot<TConfig>(options: ConfigModuleOptions<TConfig>): DynamicModule {
    const config: Readonly<TConfig> = loadConfig(options.schema, options.env);
    return {
      module: ConfigModule,
      global: true,
      providers: [{ provide: CONFIG, useValue: config }],
      exports: [CONFIG],
    };
  }
  // #endregion
}
