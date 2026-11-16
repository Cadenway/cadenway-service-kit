import type { ConstructorOptions } from 'pg-boss';
import { describe, expect, it } from 'vitest';

import { resolveJobsModuleOptions, type JobsConnectionOptions } from '../jobs/jobs-options.js';
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
});
