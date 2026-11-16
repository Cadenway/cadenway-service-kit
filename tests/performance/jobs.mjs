import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(new URL('../../packages/nest-jobs/package.json', import.meta.url));
const messagingRequire = createRequire(
  new URL('../../packages/nest-messaging/package.json', import.meta.url),
);
messagingRequire('reflect-metadata');
const { PostgreSqlContainer } = require('@testcontainers/postgresql');
const pg = require('pg');
const { NestFactory } = require('@nestjs/core');
const { JobsRuntimeModule, JobProducer, JobWorkerRegistry } = await import(
  new URL('../../packages/nest-jobs/dist/runtime/index.js', import.meta.url)
);
const { provisionJobs } = await import(
  new URL('../../packages/nest-jobs/dist/provisioning/index.js', import.meta.url)
);

const settings = {
  postgresImage: 'postgres:18.6-alpine',
  postgresCpu: 1,
  postgresMemoryBytes: 512 * 1024 * 1024,
  poolBudget: 4,
  queues: [{ name: 'performance-email' }],
  jobs: 48,
  smtpDelayMs: 50,
  runs: 3,
};
const container = await new PostgreSqlContainer(settings.postgresImage)
  .withCommand(['postgres', '-c', 'shared_preload_libraries=pg_stat_statements'])
  .withResourcesQuota({ cpu: settings.postgresCpu, memory: settings.postgresMemoryBytes })
  .start();
const admin = new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 });
let producer;
let appPool;
try {
  await admin.query("create role perf_app login password 'performance-only'");
  await admin.query('create extension pg_stat_statements');
  await provisionJobs({
    connection: { connectionString: container.getConnectionUri() },
    appRole: 'perf_app',
    queues: settings.queues,
  });
  const endpoint = new URL(container.getConnectionUri());
  endpoint.username = 'perf_app';
  endpoint.password = 'performance-only';
  const connection = { connectionString: endpoint.href };
  appPool = new pg.Pool({ ...connection, max: 1 });

  async function start(capabilities, poolSize) {
    return NestFactory.createApplicationContext(
      JobsRuntimeModule.forRoot({
        connection,
        queues: settings.queues,
        capabilities,
        poolSize,
        deadLetterCheckIntervalSeconds: 0,
      }),
      { logger: false, abortOnError: false },
    );
  }

  async function fetchCount() {
    const result = await admin.query(`
      select coalesce(sum(calls), 0)::int as calls
      from pg_stat_statements s join pg_roles r on s.userid = r.oid
      where r.rolname = 'perf_app' and lower(s.query) like '%skip locked%'
    `);
    return result.rows[0].calls;
  }

  producer = await start(['producer'], 1);
  await delay(1000);
  await admin.query('select pg_stat_statements_reset()');
  await delay(2500);
  const oneProducerPolls = await fetchCount();
  const secondProducer = await start(['producer'], 1);
  await delay(1000);
  await admin.query('select pg_stat_statements_reset()');
  await delay(2500);
  const twoProducerPolls = await fetchCount();
  await secondProducer.close();
  if (twoProducerPolls !== oneProducerPolls) {
    throw new Error(
      `Producer replicas increased worker polling: ${oneProducerPolls} -> ${twoProducerPolls}`,
    );
  }

  const idleWorker = await start(['worker'], settings.poolBudget);
  try {
    await idleWorker.get(JobWorkerRegistry).work('performance-email', () => Promise.resolve(), {
      concurrency: 1,
      pollingIntervalSeconds: 0.5,
    });
    await delay(1000);
    await admin.query('select pg_stat_statements_reset()');
    await delay(2500);
    if ((await fetchCount()) === 0) {
      throw new Error('Polling query detection did not observe an idle worker.');
    }
  } finally {
    await idleWorker.close();
  }

  async function measure(workerCount, run) {
    const client = await appPool.connect();
    try {
      await client.query('begin');
      const submit = producer.get(JobProducer);
      for (let index = 0; index < settings.jobs; index += 1) {
        await submit.enqueue({ client, organizationId: null }, 'performance-email', { index, run });
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    let completed = 0;
    const workers = [];
    const started = performance.now();
    try {
      for (let index = 0; index < workerCount; index += 1) {
        const worker = await start(['worker'], settings.poolBudget / workerCount);
        workers.push(worker);
        await worker.get(JobWorkerRegistry).work(
          'performance-email',
          async () => {
            await delay(settings.smtpDelayMs);
            completed += 1;
          },
          { concurrency: 1, pollingIntervalSeconds: 0.5 },
        );
      }
      const timeout = performance.now() + 60_000;
      while (completed < settings.jobs) {
        if (performance.now() > timeout) throw new Error('Timed out waiting for the workers.');
        await delay(20);
      }
      const elapsedMs = performance.now() - started;
      return { run, workerCount, elapsedMs, jobsPerSecond: settings.jobs / (elapsedMs / 1000) };
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
    }
  }

  const oneWorker = [];
  const twoWorkers = [];
  for (let run = 1; run <= settings.runs; run += 1) {
    oneWorker.push(await measure(1, run));
    twoWorkers.push(await measure(2, run));
  }
  const average = (runs) => runs.reduce((sum, run) => sum + run.jobsPerSecond, 0) / runs.length;
  const throughputRatio = average(twoWorkers) / average(oneWorker);
  const report = {
    settings,
    oneProducerPolls,
    twoProducerPolls,
    oneWorker,
    twoWorkers,
    throughputRatio,
  };
  if (process.argv[2] !== undefined) {
    await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
  if (throughputRatio <= 1) throw new Error('Two workers did not increase job throughput.');
} finally {
  await producer?.close();
  await appPool?.end();
  await admin.end();
  await container.stop();
}
