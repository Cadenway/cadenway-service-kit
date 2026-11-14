import { Inject, Injectable, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { baseConfigShape, type BaseConfig } from './base-config.js';
import { CONFIG, ConfigModule } from './config.module.js';
import { ConfigError, loadConfig } from './load-config.js';

/**
 * Interface TestConfig
 *
 * @description
 * Configuration of a fictional service: the base variables plus one secret of its own.
 */
interface TestConfig extends BaseConfig {
  // #region Properties
  /**
   * Property API_SECRET
   *
   * @description
   * Secret used to check that a validation error never echoes a value.
   *
   * @type {string}
   * @readonly
   */
  readonly API_SECRET: string;
  // #endregion
}

/**
 * Constant schema
 *
 * @description
 * Schema of the fictional service, composed from the base shape.
 *
 * @type {z.ZodType<TestConfig>}
 */
const schema: z.ZodType<TestConfig> = z.object({
  ...baseConfigShape,
  API_SECRET: z.string().min(32),
});

/**
 * Class ConfigReader
 *
 * @description
 * Provider that receives the validated configuration through the `CONFIG` token.
 */
@Injectable()
class ConfigReader {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Receives the configuration registered by `ConfigModule.forRoot`.
   *
   * @param {TestConfig} config - Validated configuration.
   * @constructor
   */
  public constructor(@Inject(CONFIG) public readonly config: TestConfig) {}
  // #endregion
}

describe('loadConfig', () => {
  it('returns the typed configuration with the documented defaults', () => {
    const config: Readonly<TestConfig> = loadConfig(schema, {
      PORT: '3013',
      API_SECRET: 'x'.repeat(32),
    });

    expect(config).toEqual({
      NODE_ENV: 'production',
      PORT: 3013,
      LOG_LEVEL: 'info',
      LOG_PRETTY: false,
      API_SECRET: 'x'.repeat(32),
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('treats an empty variable as unset', () => {
    const config: Readonly<TestConfig> = loadConfig(schema, {
      PORT: '3013',
      LOG_LEVEL: '',
      LOG_PRETTY: 'true',
      API_SECRET: 'x'.repeat(32),
    });

    expect(config.LOG_LEVEL).toBe('info');
    expect(config.LOG_PRETTY).toBe(true);
  });

  it('lists every invalid variable by name', () => {
    expect(() => loadConfig(schema, { PORT: '70000', LOG_LEVEL: 'loud' })).toThrow(ConfigError);
    try {
      loadConfig(schema, { PORT: '70000', LOG_LEVEL: 'loud' });
    } catch (error) {
      const issues: readonly string[] = (error as ConfigError).issues;
      expect(issues.map((issue) => issue.split(':')[0])).toEqual([
        'PORT',
        'LOG_LEVEL',
        'API_SECRET',
      ]);
    }
  });

  it('never echoes a value in the error', () => {
    const secret: string = 'too-short-secret';
    try {
      loadConfig(schema, { PORT: '3013', API_SECRET: secret });
      expect.unreachable('the short secret must be refused');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).toContain('API_SECRET');
    }
  });
});

describe('ConfigModule', () => {
  it('provides the validated configuration globally', async () => {
    /**
     * Class FeatureModule
     *
     * @description
     * Module that does not import `ConfigModule`, to prove the token is global.
     */
    @Module({ providers: [ConfigReader], exports: [ConfigReader] })
    class FeatureModule {}

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ schema, env: { PORT: '8080', API_SECRET: 'y'.repeat(32) } }),
        FeatureModule,
      ],
    }).compile();

    expect(moduleRef.get(ConfigReader).config.PORT).toBe(8080);
    await moduleRef.close();
  });

  it('throws while the module is declared when the environment is invalid', () => {
    expect(() => ConfigModule.forRoot({ schema, env: {} })).toThrow(ConfigError);
  });
});
