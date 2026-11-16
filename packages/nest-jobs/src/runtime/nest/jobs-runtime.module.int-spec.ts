import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client, type QueryResult } from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { provisionJobs, type JobQueueDeclaration } from '../../provisioning/index.js';
import {
  APP_ROLE,
  queryAs,
  startJobsTestServer,
  waitFor,
  type JobsTestDatabase,
  type JobsTestServer,
} from '../../testing/jobs-database.js';
import {
  JobProducer,
  JobScheduler,
  JobsNotProvisionedError,
  JobsRuntimeModule,
  JobWorkerRegistry,
  type Job,
  type JobEnqueueResult,
  type JobsRuntimeOptions,
} from '../index.js';

const queues: readonly JobQueueDeclaration[] = [{ name: 'digests' }];

function start(options: JobsRuntimeOptions): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(JobsRuntimeModule.forRoot(options), {
    logger: false,
    abortOnError: false,
  });
}

async function appConnections(database: JobsTestDatabase): Promise<number> {
  const result: QueryResult<{ count: number }> = await queryAs<{ count: number }>(
    database.admin,
    'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1 AND usename = $2',
    [database.name, APP_ROLE],
  );
  return result.rows[0]?.count ?? -1;
}

describe('JobsRuntimeModule', () => {
  let server: JobsTestServer;

  beforeAll(async () => {
    server = await startJobsTestServer();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('submits without starting pg-boss or owning a pool and keeps occurrence claims transactional', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    await provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues });
    const starts = vi.spyOn(PgBoss.prototype, 'start');
    try {
      const app: INestApplicationContext = await start({
        connection: database.app,
        queues,
        capabilities: ['producer'],
        poolSize: 1,
      });
      try {
        await waitFor(async (): Promise<boolean> => (await appConnections(database)) === 0, 5_000);
        const producer: JobProducer = app.get(JobProducer);
        await expect(
          app.get(JobWorkerRegistry).work('digests', () => Promise.resolve()),
        ).rejects.toThrow(/worker jobs capability is not enabled/u);
        await expect(app.get(JobScheduler).unschedule('digests')).rejects.toThrow(
          /scheduler jobs capability is not enabled/u,
        );

        const client: Client = new Client(database.app);
        await client.connect();
        try {
          const tx: Parameters<JobProducer['enqueue']>[0] = { client, organizationId: null };
          const payload: { entry: string } = { entry: 'digest' };
          const options: { occurrenceKey: string } = { occurrenceKey: 'digest:2026-11-16' };
          await client.query('BEGIN');
          const rolledBack: JobEnqueueResult = await producer.enqueue(
            tx,
            'digests',
            payload,
            options,
          );
          await client.query('ROLLBACK');
          expect(rolledBack.duplicate).toBe(false);
          expect(
            (await client.query('SELECT id FROM pgboss.job WHERE id = $1', [rolledBack.jobId]))
              .rows,
          ).toHaveLength(0);

          await client.query('BEGIN');
          await expect(producer.enqueue(tx, 'digests', payload, options)).resolves.toEqual({
            jobId: rolledBack.jobId,
            duplicate: false,
          });
          await expect(producer.enqueue(tx, 'digests', payload, options)).resolves.toEqual({
            jobId: rolledBack.jobId,
            duplicate: true,
          });
          await client.query('COMMIT');
          expect(
            (await client.query('SELECT id FROM pgboss.job WHERE id = $1', [rolledBack.jobId]))
              .rows,
          ).toHaveLength(1);
        } finally {
          await client.end();
        }
        expect(starts).not.toHaveBeenCalled();
        await waitFor(async (): Promise<boolean> => (await appConnections(database)) === 0, 5_000);
      } finally {
        await app.close();
      }
    } finally {
      starts.mockRestore();
    }
  });

  it('refuses an unprovisioned database before enabling the producer and closes the check connection', async () => {
    const database: JobsTestDatabase = await server.createDatabase();

    await expect(
      start({ connection: database.app, queues, capabilities: ['producer'], poolSize: 1 }),
    ).rejects.toBeInstanceOf(JobsNotProvisionedError);
    await waitFor(async (): Promise<boolean> => (await appConnections(database)) === 0, 5_000);
  });

  it('fires a stored cron after scheduler replacement and delivers it to a separate worker', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    await provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues });
    const schedulerOptions: JobsRuntimeOptions = {
      connection: database.app,
      queues,
      capabilities: ['producer', 'scheduler'],
      poolSize: 1,
    };
    const first: INestApplicationContext = await start(schedulerOptions);
    try {
      await first.get(JobScheduler).schedule('digests', '* * * * *', {
        timeZone: 'UTC',
        payload: { kind: 'tick' },
      });
    } finally {
      await first.close();
    }

    // Allow the replacement's first cron pass to acquire the claim immediately.
    await queryAs(database.admin, 'UPDATE pgboss.version SET cron_on = NULL');
    const received: Job[] = [];
    const worker: INestApplicationContext = await start({
      connection: database.app,
      queues,
      capabilities: ['worker'],
      poolSize: 1,
    });
    try {
      await worker.get(JobWorkerRegistry).work(
        'digests',
        (job: Job): Promise<void> => {
          received.push(job);
          return Promise.resolve();
        },
        { concurrency: 2, pollingIntervalSeconds: 0.5 },
      );
      const replacement: INestApplicationContext = await start(schedulerOptions);
      try {
        await waitFor((): boolean => received.length > 0, 45_000);
        expect(received[0]).toMatchObject({
          queue: 'digests',
          payload: { kind: 'tick' },
          organizationId: null,
          attempt: 1,
        });
        expect(await appConnections(database)).toBeLessThanOrEqual(2);
      } finally {
        await replacement.close();
      }
    } finally {
      await worker.close();
    }
    await waitFor(async (): Promise<boolean> => (await appConnections(database)) === 0, 5_000);
  });
});
