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

/**
 * Constant queues
 *
 * @description
 * Queue shared by the producer, worker and scheduler integration scenarios.
 *
 * @type {readonly JobQueueDeclaration[]}
 */
const queues: readonly JobQueueDeclaration[] = [{ name: 'digests' }];

/**
 * Function start
 *
 * @description
 * Starts an isolated Nest application with configuration and startup errors exposed to the test.
 *
 * @param {JobsRuntimeOptions} options - Connection, queues and process capabilities under test.
 * @returns {Promise<INestApplicationContext>} Started application whose lifecycle the test owns.
 */
function start(options: JobsRuntimeOptions): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(JobsRuntimeModule.forRoot(options), {
    logger: false,
    abortOnError: false,
  });
}

/**
 * Function appConnections
 *
 * @description
 * Observes PostgreSQL sessions owned by the application role in the test database.
 *
 * @param {JobsTestDatabase} database - Disposable database whose application sessions are counted.
 * @returns {Promise<number>} Current application connection count.
 */
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

  it('lets a second worker process another organization while the first group is busy', async () => {
    const database = await server.createDatabase();
    const grouped = { name: 'organization-work', organizationConcurrency: 1 } as const;
    const groupedQueues = [grouped];
    await provisionJobs({
      connection: database.migrator,
      appRole: APP_ROLE,
      queues: groupedQueues,
    });
    const groupedOptions = { connection: database.app, queues: groupedQueues, poolSize: 1 };
    const producerApp = await start({
      ...groupedOptions,
      capabilities: ['producer'],
    });
    const firstWorker = await start({
      ...groupedOptions,
      capabilities: ['worker'],
    });
    const secondWorker = await start({
      ...groupedOptions,
      capabilities: ['worker'],
    });
    const client = new Client(database.app);
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tenantA = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e01';
    const tenantB = '019a700b-1a2b-7c3d-8e4f-5a6b7c8d9e02';
    const seen: string[] = [];
    let activeA = 0;
    let peakA = 0;
    const work = async (job: Job) => {
      if (job.organizationId === null) throw new Error('Expected a tenant job.');
      seen.push(job.organizationId.toLowerCase());
      if (job.organizationId.toLowerCase() === tenantA) {
        activeA += 1;
        peakA = Math.max(peakA, activeA);
        await hold;
        activeA -= 1;
      }
    };
    try {
      const producer = producerApp.get(JobProducer);
      await client.connect();
      for (const worker of [firstWorker, secondWorker]) {
        await worker.get(JobWorkerRegistry).work(grouped.name, work, {
          concurrency: 1,
          pollingIntervalSeconds: 0.5,
        });
      }
      await client.query('BEGIN');
      await producer.enqueue({ client, organizationId: tenantA }, grouped.name, null);
      await client.query('COMMIT');
      await waitFor(() => activeA === 1, 10_000);
      await client.query('BEGIN');
      await producer.enqueue({ client, organizationId: tenantA.toUpperCase() }, grouped.name, null);
      await producer.enqueue({ client, organizationId: tenantB }, grouped.name, null);
      await client.query('COMMIT');
      await waitFor(() => seen.includes(tenantB), 10_000);
      expect(seen).toEqual([tenantA, tenantB]);
      expect(peakA).toBe(1);

      release();
      await waitFor(() => seen.length === 3, 10_000);
      expect(seen).toEqual([tenantA, tenantB, tenantA]);
      expect(peakA).toBe(1);
    } finally {
      release();
      await client.end();
      await Promise.all([producerApp.close(), firstWorker.close(), secondWorker.close()]);
    }
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

  it.each([
    { firstResult: 'COMMIT', duplicate: true },
    { firstResult: 'ROLLBACK', duplicate: false },
  ])(
    'resolves concurrent occurrence claims after the first transaction ends with $firstResult',
    async ({ firstResult, duplicate }) => {
      const database: JobsTestDatabase = await server.createDatabase();
      await provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues });
      const app: INestApplicationContext = await start({
        connection: database.app,
        queues,
        capabilities: ['producer'],
        poolSize: 1,
      });
      const first: Client = new Client(database.app);
      const second: Client = new Client(database.app);
      try {
        await first.connect();
        await second.connect();
        const firstPid = (await first.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]?.pid;
        const secondPid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]?.pid;
        const producer: JobProducer = app.get(JobProducer);
        const payload = { entry: 'digest' };
        const options = { occurrenceKey: 'digest:concurrent' };
        await first.query('BEGIN');
        const winner: JobEnqueueResult = await producer.enqueue(
          { client: first, organizationId: null },
          'digests',
          payload,
          options,
        );
        expect(winner.duplicate).toBe(false);
        await second.query('BEGIN');
        const contender: Promise<JobEnqueueResult> = producer.enqueue(
          { client: second, organizationId: null },
          'digests',
          payload,
          options,
        );
        void contender.catch(() => undefined);
        await waitFor(async () => {
          const result = await queryAs<{ blocked: boolean }>(
            database.admin,
            'SELECT $1 = ANY(pg_catalog.pg_blocking_pids($2)) AS blocked',
            [firstPid, secondPid],
          );
          return result.rows[0]?.blocked === true;
        }, 5_000);

        await first.query(firstResult);
        await expect(contender).resolves.toEqual({ jobId: winner.jobId, duplicate });
        await second.query('COMMIT');
        expect(
          (await second.query('SELECT id FROM pgboss.job WHERE name = $1', ['digests'])).rows,
        ).toEqual([{ id: winner.jobId }]);
      } finally {
        await Promise.all([first.end(), second.end(), app.close()]);
      }
    },
  );

  it('fires a stored cron after scheduler replacement and delivers it to a separate worker', async () => {
    const database: JobsTestDatabase = await server.createDatabase();
    await provisionJobs({ connection: database.migrator, appRole: APP_ROLE, queues });
    const schedulerOptions: JobsRuntimeOptions = {
      connection: database.app,
      queues,
      capabilities: ['scheduler'],
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
