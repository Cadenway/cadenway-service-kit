import { z } from 'zod';

import type { ConfigShape } from '../config/base-config.js';

/**
 * Interface RedisConfig
 *
 * @description
 * Variable of an application with a Redis connection, as validated by `redisConfigShape`.
 */
export interface RedisConfig {
  // #region Properties
  /**
   * Property REDIS_URL
   *
   * @description
   * URL of the Redis server, `redis://` or `rediss://`. A secret when it carries a password.
   *
   * @type {string}
   * @readonly
   */
  readonly REDIS_URL: string;
  // #endregion
}

/**
 * Constant redisConfigShape
 *
 * @description
 * Zod shape of `REDIS_URL`, a `redis://` or `rediss://` URL. Spread it into the application
 * schema. The error names the expectation, never the value.
 *
 * @type {ConfigShape<RedisConfig>}
 */
export const redisConfigShape: ConfigShape<RedisConfig> = {
  REDIS_URL: z.url({ protocol: /^rediss?$/u, error: 'Expected a redis:// or rediss:// URL.' }),
};
