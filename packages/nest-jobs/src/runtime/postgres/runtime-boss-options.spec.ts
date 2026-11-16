import type { ConstructorOptions } from 'pg-boss';
import { describe, expect, it } from 'vitest';

import {
  resolveJobsRuntimeOptions,
  resolveLegacyJobsRuntimeOptions,
  type JobsCapability,
} from '../../jobs/configuration/jobs-runtime-options.js';
import type { JobsConnectionOptions } from '../../jobs/database/jobs-connection.js';
import { toRuntimeBossOptions } from './runtime-boss-options.js';

/**
 * Constant connection
 *
 * @description
 * Connection options of a server that is never contacted by these specs.
 *
 * @type {JobsConnectionOptions}
 */
const connection: JobsConnectionOptions = {
  host: 'database.internal',
  user: 'service_app',
  database: 'service',
};

describe('toRuntimeBossOptions', () => {
  it('never lets the runtime run DDL and keeps its pool at two connections', () => {
    const resolved = resolveLegacyJobsRuntimeOptions({ connection, queues: [], schema: 'jobs' });
    expect(resolved.capabilities).toEqual(
      new Set<JobsCapability>(['producer', 'worker', 'scheduler']),
    );
    const options: ConstructorOptions = toRuntimeBossOptions(resolved);

    expect(options).toEqual({
      host: 'database.internal',
      user: 'service_app',
      database: 'service',
      schema: 'jobs',
      max: 2,
      migrate: false,
      createSchema: false,
      supervise: true,
      schedule: true,
      reindex: false,
      persistQueueStats: false,
      persistWarnings: false,
    });
  });

  it('does not let a connection object override the fixed settings', () => {
    const hostile: unknown = { ...connection, migrate: true, max: 50, schema: 'public' };

    const options: ConstructorOptions = toRuntimeBossOptions(
      resolveLegacyJobsRuntimeOptions({ connection: hostile as JobsConnectionOptions, queues: [] }),
    );

    expect(options.migrate).toBe(false);
    expect(options.max).toBe(2);
    expect(options.schema).toBe('pgboss');
  });

  it.each<{ capability: JobsCapability; scheduler: boolean }>([
    { capability: 'producer', scheduler: false },
    { capability: 'worker', scheduler: false },
    { capability: 'scheduler', scheduler: true },
  ])(
    'only enables cron and supervision for a scheduler with $capability',
    ({ capability, scheduler }) => {
      const resolved = resolveJobsRuntimeOptions({
        connection,
        queues: [],
        capabilities: [capability],
        poolSize: 3,
      });

      expect(resolved.capabilities).toEqual(new Set<JobsCapability>([capability]));
      expect(toRuntimeBossOptions(resolved)).toMatchObject({
        max: 3,
        schedule: scheduler,
        supervise: scheduler,
        migrate: false,
      });
    },
  );

  it('fails fast for absent or duplicate capabilities and invalid pool budgets', () => {
    expect(() =>
      resolveJobsRuntimeOptions({ connection, queues: [], capabilities: [], poolSize: 1 }),
    ).toThrow(/capabilities/u);
    expect(() =>
      resolveJobsRuntimeOptions({
        connection,
        queues: [],
        capabilities: ['worker', 'worker'],
        poolSize: 1,
      }),
    ).toThrow(/capabilities/u);
    expect(() =>
      resolveJobsRuntimeOptions({
        connection,
        queues: [],
        capabilities: ['worker'],
        poolSize: 0,
      }),
    ).toThrow(/poolSize/u);
  });
});
