import type { ConstructorOptions } from 'pg-boss';
import { describe, expect, it } from 'vitest';

import {
  assertRoleName,
  assertSchemaName,
  resolveJobsModuleOptions,
  toRuntimeBossOptions,
  type JobsConnectionOptions,
  type JobsModuleOptions,
  type ResolvedJobsModuleOptions,
} from './jobs-options.js';

/**
 * Constant connection
 *
 * @description
 * Connection options of a server that is never contacted by these specs.
 *
 * @type {JobsConnectionOptions}
 */
const connection: JobsConnectionOptions = { host: 'database.internal', database: 'service' };

describe('resolveJobsModuleOptions', () => {
  it('applies the documented defaults', async () => {
    const options: ResolvedJobsModuleOptions = resolveJobsModuleOptions({ connection, queues: [] });
    let ran: boolean = false;

    await options.runInOrganization('org-1', (): Promise<void> => {
      ran = true;
      return Promise.resolve();
    });

    expect(options.schema).toBe('pgboss');
    expect(options.shutdownTimeoutMs).toBe(30_000);
    expect(options.queues).toEqual([]);
    expect(ran).toBe(true);
  });

  it('keeps the given options and resolves the queues', () => {
    const runInOrganization: JobsModuleOptions['runInOrganization'] = (
      _organizationId: string | null,
      work: () => Promise<void>,
    ): Promise<void> => work();

    const options: ResolvedJobsModuleOptions = resolveJobsModuleOptions({
      connection,
      queues: [{ name: 'reminders' }],
      schema: 'jobs',
      runInOrganization,
      shutdownTimeoutMs: 5_000,
    });

    expect(options.schema).toBe('jobs');
    expect(options.shutdownTimeoutMs).toBe(5_000);
    expect(options.runInOrganization).toBe(runInOrganization);
    expect(options.queues[0]?.deadLetter).toBe('reminders.dead-letter');
  });

  it.each([
    ['no connection', { queues: [] }, /connection is required/],
    ['a connection that names no server', { connection: {}, queues: [] }, /connectionString or a/],
    ['an uppercase schema', { connection, queues: [], schema: 'Jobs' }, /schema must be/],
    ['a quoted schema', { connection, queues: [], schema: '"jobs"' }, /schema must be/],
    ['a short shutdown', { connection, queues: [], shutdownTimeoutMs: 999 }, /shutdownTimeoutMs/],
    ['a wrapper that is not a function', { connection, queues: [], runInOrganization: 1 }, /runIn/],
    ['an invalid queue', { connection, queues: [{ name: 'a b' }] }, /Queue name must contain/],
  ])('rejects %s', (_case: string, options: unknown, message: RegExp) => {
    expect(() => resolveJobsModuleOptions(options as JobsModuleOptions)).toThrow(message);
  });
});

describe('toRuntimeBossOptions', () => {
  it('never lets the runtime run DDL and keeps its pool at two connections', () => {
    const options: ConstructorOptions = toRuntimeBossOptions(
      resolveJobsModuleOptions({ connection, queues: [], schema: 'jobs' }),
    );

    expect(options).toEqual({
      host: 'database.internal',
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
    const hostile: unknown = { host: 'database.internal', migrate: true, max: 50 };

    const options: ConstructorOptions = toRuntimeBossOptions(
      resolveJobsModuleOptions({ connection: hostile as JobsConnectionOptions, queues: [] }),
    );

    expect(options.migrate).toBe(false);
    expect(options.max).toBe(2);
  });
});

describe('assertSchemaName and assertRoleName', () => {
  it('accept lowercase identifiers', () => {
    expect(() => {
      assertSchemaName('pgboss_jobs');
      assertRoleName('task_app');
    }).not.toThrow();
  });

  it.each([['Task_App'], ['task-app'], ['1app'], ['task"; DROP ROLE x; --'], [''], [undefined]])(
    'reject %j',
    (name: unknown) => {
      expect(() => {
        assertRoleName(name);
      }).toThrow(/appRole must be/);
      expect(() => {
        assertSchemaName(name);
      }).toThrow(/schema must be/);
    },
  );

  it('reject names longer than the limits', () => {
    expect(() => {
      assertSchemaName('s'.repeat(51));
    }).toThrow(/schema must be/);
    expect(() => {
      assertRoleName('r'.repeat(64));
    }).toThrow(/appRole must be/);
  });
});
