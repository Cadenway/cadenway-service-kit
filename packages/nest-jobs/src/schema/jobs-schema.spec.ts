import { describe, expect, it } from 'vitest';

import { assertRoleName, assertSchemaName } from './jobs-schema.js';

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
