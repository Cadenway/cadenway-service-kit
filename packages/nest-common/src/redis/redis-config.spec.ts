import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { loadConfig, type ConfigError } from '../config/load-config.js';
import { redisConfigShape, type RedisConfig } from './redis-config.js';

/**
 * Constant schema
 *
 * @description
 * Schema of an application reading `REDIS_URL` only.
 *
 * @type {z.ZodType<RedisConfig>}
 */
const schema: z.ZodType<RedisConfig> = z.object({ ...redisConfigShape });

describe('redisConfigShape', () => {
  it('accepts a redis:// and a rediss:// URL', () => {
    expect(loadConfig(schema, { REDIS_URL: 'redis://redis:6379' }).REDIS_URL).toBe(
      'redis://redis:6379',
    );
    expect(loadConfig(schema, { REDIS_URL: 'rediss://redis.internal:6380/1' }).REDIS_URL).toBe(
      'rediss://redis.internal:6380/1',
    );
  });

  it('refuses another scheme and a missing URL without echoing the value', () => {
    const issuesOf: (env: Record<string, string>) => readonly string[] = (
      env: Record<string, string>,
    ) => {
      try {
        loadConfig(schema, env);
      } catch (error) {
        return (error as ConfigError).issues;
      }
      return [];
    };

    expect(issuesOf({ REDIS_URL: 'http://user:secret@redis:6379' })).toEqual([
      'REDIS_URL: Expected a redis:// or rediss:// URL.',
    ]);
    expect(issuesOf({})).toEqual(['REDIS_URL: required, not set']);
  });
});
