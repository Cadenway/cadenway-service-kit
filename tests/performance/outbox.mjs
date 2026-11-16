import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cpus, freemem, platform, totalmem } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(
  new URL('../../packages/nest-messaging/package.json', import.meta.url),
);
const { PostgreSqlContainer } = require('@testcontainers/postgresql');
const pg = require('pg');
const { SystemTransactionRunner } = await import(
  new URL('../../packages/nest-common/dist/database/index.js', import.meta.url)
);

const mode = process.argv[2];
if (!['baseline', 'candidate'].includes(mode)) {
  throw new Error('Usage: node tests/performance/outbox.mjs baseline|candidate [baseline.json]');
}

const baselineFile = process.argv[3] ?? fileURLToPath(new URL('./baseline.json', import.meta.url));
const sourceFile = new URL(
  mode === 'baseline'
    ? '../../packages/nest-messaging/dist/outbox/relay/outbox-relay.js'
    : '../../packages/nest-messaging/dist/outbox/relay/leased/leased-outbox-relay.js',
  import.meta.url,
);
const sourceHash = createHash('sha256')
  .update(await readFile(sourceFile))
  .digest('hex');
const module = await import(pathToFileURL(fileURLToPath(sourceFile)).href);
const config = {
  runs: 3,
  events: 120,
  simulatedAckMs: 50,
  poolSize: 4,
  postgresImage: 'postgres:18.6-alpine',
  postgresCpu: 1,
  postgresMemoryBytes: 512 * 1024 * 1024,
  httpConcurrency: 1,
};
const machine = {
  platform: platform(),
  cpus: cpus().length,
  cpu: cpus()[0]?.model,
  totalMemoryBytes: totalmem(),
  node: process.version,
};

function percentile(samples, quantile) {
  if (samples.length === 0) throw new Error('No HTTP or transaction samples were recorded.');
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(quantile * sorted.length) - 1];
}

async function setupDatabase(pool) {
  await pool.query(`
    create table outbox_events (
      id uuid primary key, event_name text not null, subject text not null, stream text not null,
      organization_id uuid, payload jsonb not null, traceparent text,
      status text not null default 'pending',
      attempts integer not null default 0, next_attempt_at timestamptz not null default now(),
      last_error text, created_at timestamptz not null default now(), sent_at timestamptz,
      lease_token uuid, lease_expires_at timestamptz
    );
    create index outbox_events_pending_index on outbox_events(next_attempt_at, created_at)
      where status = 'pending';
    create index outbox_events_lease_expiry_index on outbox_events(lease_expires_at)
      where status = 'leased';
  `);
}

async function run(pool, admin, ordinal) {
  await admin.query('truncate outbox_events');
  await admin.query(
    `
    insert into outbox_events(id, event_name, subject, stream, payload)
    select uuidv7(), 'task.updated.v1', 'evt.task.updated.v1', 'EVENTS',
           jsonb_build_object('id', uuidv7()::text, 'occurredAt', now()::text,
                              'organizationId', null, 'actor', jsonb_build_object('type','system','id',null),
                              'version', 1)
    from generate_series(1, $1)
  `,
    [config.events],
  );
  const times = [];
  const runner = new SystemTransactionRunner(pool);
  const instrumented = {
    run: async (work, options) => {
      const start = performance.now();
      try {
        return await runner.run(work, options);
      } finally {
        times.push(performance.now() - start);
      }
    },
  };
  const publisher = { publishEnvelope: async () => delay(config.simulatedAckMs) };
  let relay;
  if (mode === 'baseline') {
    relay = new module.OutboxRelay(instrumented, publisher, {
      relay: false,
      batchSize: 100,
      pollIntervalMs: 1000,
      purgeIntervalMs: 0,
      retentionDays: 7,
      processedRetentionDays: 14,
    });
  } else {
    const optionsModule = await import(
      new URL(
        '../../packages/nest-messaging/dist/outbox/relay/leased/outbox-relay-options.js',
        import.meta.url,
      )
    );
    const options = optionsModule.resolveOutboxRelayOptions({ autoStart: false, concurrency: 4 });
    relay = new module.LeasedOutboxRelay(instrumented, publisher, options);
  }

  const server = createServer(async (_request, response) => {
    try {
      await pool.query('select 1');
      response.writeHead(204).end();
    } catch {
      response.writeHead(503).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const http = [];
  let sampling = true;
  let httpFailure;
  let peakWaiting = 0;
  let peakActive = 0;
  let maxRssBytes = process.memoryUsage.rss();
  const sampler = setInterval(() => {
    peakWaiting = Math.max(peakWaiting, pool.waitingCount);
    peakActive = Math.max(peakActive, pool.totalCount - pool.idleCount);
    maxRssBytes = Math.max(maxRssBytes, process.memoryUsage.rss());
  }, 10);
  const probe = (async () => {
    while (sampling) {
      const started = performance.now();
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        if (response.status !== 204) throw new Error(`HTTP probe returned ${response.status}`);
        http.push(performance.now() - started);
      } catch (error) {
        httpFailure = error;
        return;
      }
      await delay(20);
    }
  })();
  let peakBacklogAgeMs = 0;
  const started = performance.now();
  let elapsedMs;
  try {
    for (;;) {
      const result = await relay.publishPending();
      if (result.failed || result.interrupted)
        throw new Error('Relay reported a publication failure.');
      const { rows } = await admin.query(
        `select count(*)::int as pending,
                coalesce(extract(epoch from (clock_timestamp() - min(created_at))) * 1000, 0)::float8 as age
           from outbox_events where status <> 'sent'`,
      );
      peakBacklogAgeMs = Math.max(peakBacklogAgeMs, rows[0].age);
      if (rows[0].pending === 0) break;
      if (performance.now() - started > 120_000)
        throw new Error('Timed out waiting for outbox drain.');
    }
    elapsedMs = performance.now() - started;
  } finally {
    sampling = false;
    clearInterval(sampler);
    await probe;
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (httpFailure) throw httpFailure;
  return {
    run: ordinal,
    elapsedMs,
    eventsPerSecond: config.events / (elapsedMs / 1000),
    httpP95Ms: percentile(http, 0.95),
    httpP99Ms: percentile(http, 0.99),
    httpSamples: http.length,
    transactionP95Ms: percentile(times, 0.95),
    peakWaiting,
    peakActive,
    peakBacklogAgeMs,
    maxRssBytes,
  };
}

const container = await new PostgreSqlContainer(config.postgresImage)
  .withResourcesQuota({ cpu: config.postgresCpu, memory: config.postgresMemoryBytes })
  .start();
const pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: config.poolSize });
const admin = new pg.Pool({ connectionString: container.getConnectionUri(), max: 1 });
try {
  await setupDatabase(admin);
  const runs = [];
  for (let index = 0; index < config.runs; index += 1) {
    runs.push(await run(pool, admin, index + 1));
  }
  const report = { mode, config, machine, freeMemoryBytes: freemem(), sourceHash, runs };
  if (mode === 'baseline') {
    await writeFile(baselineFile, JSON.stringify(report, null, 2) + '\n');
  } else {
    const baseline = JSON.parse(await readFile(baselineFile, 'utf8'));
    if (
      JSON.stringify(baseline.config) !== JSON.stringify(config) ||
      JSON.stringify(baseline.machine) !== JSON.stringify(machine)
    ) {
      throw new Error(
        'Baseline settings or host differ from this candidate. Rerun both on the same host.',
      );
    }
    const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const throughputRatio =
      average(runs.map((item) => item.eventsPerSecond)) /
      average(baseline.runs.map((item) => item.eventsPerSecond));
    const latencyRatio =
      average(runs.map((item) => item.httpP95Ms)) /
      average(baseline.runs.map((item) => item.httpP95Ms));
    report.comparison = { throughputRatio, latencyRatio };
    console.log(JSON.stringify(report, null, 2));
    if (throughputRatio < 1.5 || latencyRatio > 1.1) {
      throw new Error('Performance acceptance thresholds were not met.');
    }
  }
  if (mode === 'baseline') console.log(JSON.stringify(report, null, 2));
} finally {
  await pool.end();
  await admin.end();
  await container.stop();
}
