import { Module, type DynamicModule, type Provider } from '@nestjs/common';
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
   * Environment to validate. Defaults to `process.env`, read when the validation runs.
   *
   * @type {ConfigEnvironment | undefined}
   * @readonly
   */
  readonly env?: ConfigEnvironment;

  /**
   * Property eager
   *
   * @description
   * When the environment is read and validated. Defaults to `true`: inside `forRoot`, while the
   * application module is declared, so merely importing that module throws on an invalid
   * environment. With `false`, in the factory of the `CONFIG` provider, when the application is
   * created: importing the module validates nothing, and `createApplication` (or the testing
   * module) rejects with the `ConfigError`. Either way the process never listens with a partial
   * configuration.
   *
   * @type {boolean | undefined}
   * @readonly
   */
  readonly eager?: boolean;
  // #endregion
}

/**
 * Class ConfigModule
 *
 * @description
 * Validates the environment once and provides the result under the `CONFIG` token, globally.
 *
 * By default validation runs inside `forRoot`, while the application module is being declared:
 * an invalid environment throws a `ConfigError` before NestJS creates anything. With
 * `eager: false` it runs when NestJS creates the `CONFIG` provider, so a test can import the
 * application module statically and choose its environment before creating the application.
 * `forValue` provides a configuration that was already validated, so `main.ts` validates the
 * environment once.
 */
@Module({})
export class ConfigModule {
  // #region Methods
  /**
   * Method forRoot
   *
   * @description
   * Validates the environment against the schema, now or when the application is created
   * (`eager`), and registers the frozen result globally.
   *
   * @param {ConfigModuleOptions<TConfig>} options - Schema and, optionally, the environment to read and when to validate it.
   * @returns {DynamicModule} The global module providing `CONFIG`.
   * @throws {ConfigError} When `eager` is not `false` and a variable is missing or invalid.
   */
  public static forRoot<TConfig>(options: ConfigModuleOptions<TConfig>): DynamicModule {
    const provider: Provider =
      options.eager === false
        ? {
            provide: CONFIG,
            useFactory: (): Readonly<TConfig> =>
              loadConfig(options.schema, options.env ?? process.env),
          }
        : { provide: CONFIG, useValue: loadConfig(options.schema, options.env) };
    return {
      module: ConfigModule,
      global: true,
      providers: [provider],
      exports: [CONFIG],
    };
  }

  /**
   * Method forValue
   *
   * @description
   * Registers an already validated configuration globally under the `CONFIG` token, without
   * reading the environment again: the result of the `loadConfig` call of `main.ts`, or the
   * configuration of a test. `createApplication` uses it when `provideConfig` is set. An
   * application provides `CONFIG` once: either this or `forRoot`, never both.
   *
   * @param {Readonly<TConfig>} value - Configuration returned by `loadConfig`.
   * @returns {DynamicModule} The global module providing `CONFIG`.
   */
  public static forValue<TConfig extends object>(value: Readonly<TConfig>): DynamicModule {
    return {
      module: ConfigModule,
      global: true,
      providers: [
        { provide: CONFIG, useValue: Object.isFrozen(value) ? value : Object.freeze({ ...value }) },
      ],
      exports: [CONFIG],
    };
  }
  // #endregion
}
