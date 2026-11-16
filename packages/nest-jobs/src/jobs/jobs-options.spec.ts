import { describe, expect, it } from 'vitest';

import { assertRoleName, assertSchemaName } from '../schema/jobs-schema.js';
import {
  assertConnection,
  resolveJobsModuleOptions,
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
const connection: JobsConnectionOptions = {
  host: 'database.internal',
  user: 'service_app',
  database: 'service',
};

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
    expect(options.deadLetterCheckIntervalSeconds).toBe(60);
    expect(options.allowPrivilegedRole).toBe(false);
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
      deadLetterCheckIntervalSeconds: 0,
      allowPrivilegedRole: true,
    });

    expect(options.schema).toBe('jobs');
    expect(options.shutdownTimeoutMs).toBe(5_000);
    expect(options.deadLetterCheckIntervalSeconds).toBe(0);
    expect(options.allowPrivilegedRole).toBe(true);
    expect(options.runInOrganization).toBe(runInOrganization);
    expect(options.queues[0]?.deadLetter).toBe('reminders.dead-letter');
  });

  it.each([
    ['no connection', { queues: [] }, /connection is required/],
    ['a connection that names no server', { connection: {}, queues: [] }, /connectionString, or/],
    ['an uppercase schema', { connection, queues: [], schema: 'Jobs' }, /schema must be/],
    ['a quoted schema', { connection, queues: [], schema: '"jobs"' }, /schema must be/],
    ['the public schema', { connection, queues: [], schema: 'public' }, /schema of its own/],
    ['a short shutdown', { connection, queues: [], shutdownTimeoutMs: 999 }, /shutdownTimeoutMs/],
    ['a wrapper that is not a function', { connection, queues: [], runInOrganization: 1 }, /runIn/],
    [
      'a negative dead-letter interval',
      { connection, queues: [], deadLetterCheckIntervalSeconds: -1 },
      /deadLetterCheckIntervalSeconds must be an integer of at least 0/,
    ],
    [
      'a fractional dead-letter interval',
      { connection, queues: [], deadLetterCheckIntervalSeconds: 0.5 },
      /deadLetterCheckIntervalSeconds/,
    ],
    [
      'a privileged-role flag that is not a boolean',
      { connection, queues: [], allowPrivilegedRole: 'yes' },
      /allowPrivilegedRole must be a boolean/,
    ],
    ['an invalid queue', { connection, queues: [{ name: 'a b' }] }, /Queue name must contain/],
  ])('rejects %s', (_case: string, options: unknown, message: RegExp) => {
    expect(() => resolveJobsModuleOptions(options as JobsModuleOptions)).toThrow(message);
  });
});

describe('assertConnection', () => {
  it.each([
    ['a connection URI', { connectionString: 'postgres://service_app@database.internal/service' }],
    ['a host with its user and database', connection],
  ])('accepts %s', (_case: string, candidate: JobsConnectionOptions) => {
    expect(() => {
      assertConnection(candidate);
    }).not.toThrow();
  });

  it.each([
    ['a host alone', { host: 'database.internal' }],
    ['a host without a user', { host: 'database.internal', database: 'service' }],
    ['a host without a database', { host: 'database.internal', user: 'service_app' }],
    ['a user and a database without a host', { user: 'service_app', database: 'service' }],
    ['an empty connection URI', { connectionString: '' }],
  ])(
    'rejects %s, which would be completed from the PG* variables',
    (_case: string, candidate: JobsConnectionOptions) => {
      expect(() => {
        assertConnection(candidate);
      }).toThrow(/connection needs a connectionString, or a host with a user and a database/);
    },
  );
});

describe('assertSchemaName and assertRoleName', () => {
  it('accept lowercase identifiers', () => {
    expect(() => {
      assertSchemaName('pgboss_jobs');
      assertSchemaName('publications');
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

  it.each([['public'], ['information_schema'], ['pg_catalog'], ['pg_temp_3']])(
    'reject the reserved schema %s',
    (schema: string) => {
      expect(() => {
        assertSchemaName(schema);
      }).toThrow(/schema must be a schema of its own/);
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
