import type { ConstructorOptions } from 'pg-boss';
import { describe, expect, it } from 'vitest';

import { resolveJobsModuleOptions } from '../../jobs/configuration/jobs-options.js';
import { resolveJobsRuntimeOptions } from '../../jobs/configuration/jobs-runtime-options.js';
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
    const options: ConstructorOptions = toRuntimeBossOptions(
      resolveJobsModuleOptions({ connection, queues: [], schema: 'jobs' }),
    );

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
      resolveJobsModuleOptions({ connection: hostile as JobsConnectionOptions, queues: [] }),
    );

    expect(options.migrate).toBe(false);
    expect(options.max).toBe(2);
    expect(options.schema).toBe('pgboss');
  });

  it('gives workers a separate pool limit and leaves cron and supervision to the scheduler', () => {
    const worker: ConstructorOptions = toRuntimeBossOptions(
      resolveJobsRuntimeOptions({
        connection,
        queues: [],
        capabilities: ['worker'],
        poolSize: 3,
      }),
    );
    const scheduler: ConstructorOptions = toRuntimeBossOptions(
      resolveJobsRuntimeOptions({
        connection,
        queues: [],
        capabilities: ['producer', 'scheduler'],
        poolSize: 1,
      }),
    );

    expect(worker).toMatchObject({ max: 3, schedule: false, supervise: false, migrate: false });
    expect(scheduler).toMatchObject({ max: 1, schedule: true, supervise: true, migrate: false });
  });

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
