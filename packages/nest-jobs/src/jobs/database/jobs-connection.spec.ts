import { describe, expect, it } from 'vitest';

import { assertConnection, type JobsConnectionOptions } from './jobs-connection.js';

describe('assertConnection', () => {
  it.each([
    ['a connection URI', { connectionString: 'postgres://service_app@database.internal/service' }],
    [
      'a host with its user and database',
      { host: 'database.internal', user: 'service_app', database: 'service' },
    ],
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
