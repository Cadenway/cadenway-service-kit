import { setTimeout as sleep } from 'node:timers/promises';

import { Logger } from '@nestjs/common';
import type { QueryResult } from 'pg';
import { PgBoss, type Job as BossJob } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveJobsModuleOptions, toRuntimeBossOptions } from './jobs-options.js';
import { provisionJobs } from './provision-jobs.js';
import {
  APP_ROLE,
  queryAs,
  startJobsTestServer,
  type JobsTestDatabase,
  type JobsTestServer,
} from './testing/jobs-database.js';

/**
 * Function relationCount
 *
 * @description
 * Counts the tables, indexes and sequences of the pg-boss schema, to show that a pass created or
 * dropped none.
 *
 * @param {JobsTestDatabase} database - Database to read.
 * @returns {Promise<number>} Number of relations in the schema.
 */
async function relationCount(database: JobsTestDatabase): Promise<number> {
  const result: QueryResult<{ count: number }> = await queryAs<{ count: number }>(
    database.admin,
    `SELECT count(*)::int AS count
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'pgboss'`,
  );
  return result.rows[0]?.count ?? -1;
}

describe('toRuntimeBossOptions against PostgreSQL', () => {
  let server: JobsTestServer;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    server = await startJobsTestServer();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('lets pg-boss supervise as the application role: an expired attempt is retried and a finished job deleted, without DDL', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    await provisionJobs({
      connection: database.migrator,
      appRole: APP_ROLE,
      queues: [{ name: 'reminders', expireInSeconds: 1, deleteAfterSeconds: 1 }],
    });
    const errors: Error[] = [];
    const boss: PgBoss = new PgBoss(
      toRuntimeBossOptions(
        resolveJobsModuleOptions({
          connection: database.app,
          queues: [{ name: 'reminders', expireInSeconds: 1, deleteAfterSeconds: 1 }],
        }),
      ),
    );
    boss.on('error', (error: Error): void => {
      errors.push(error);
    });
    await boss.start();

    try {
      await boss.send('reminders', { organizationId: null, payload: { step: 'finished' } });
      const finished: BossJob[] = await boss.fetch('reminders');
      await boss.complete('reminders', finished[0]?.id ?? '');
      const abandonedId: string | null = await boss.send('reminders', {
        organizationId: null,
        payload: { step: 'abandoned' },
      });
      const abandoned: BossJob[] = await boss.fetch('reminders');
      expect(abandoned.map((job: BossJob): string => job.id)).toEqual([abandonedId]);
      await sleep(2_200);
      const relationsBefore: number = await relationCount(database);

      await boss.supervise();

      const remaining: QueryResult<{ id: string; state: string }> = await queryAs<{
        id: string;
        state: string;
      }>(
        database.admin,
        "SELECT id, state::text AS state FROM pgboss.job WHERE name = 'reminders'",
      );
      expect(remaining.rows).toEqual([{ id: abandonedId, state: 'retry' }]);
      expect(await relationCount(database)).toBe(relationsBefore);
      expect(errors).toEqual([]);
    } finally {
      await boss.stop();
    }
  });
});
