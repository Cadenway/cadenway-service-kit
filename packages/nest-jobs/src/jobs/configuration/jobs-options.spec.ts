import { describe, expect, it } from 'vitest';

import type { JobsConnectionOptions } from '../database/jobs-connection.js';
import {
  resolveJobsModuleOptions,
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
