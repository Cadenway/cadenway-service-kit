# @cadenway/nest-jobs

Durable background jobs for the Cadenway NestJS services, kept in each service's own PostgreSQL
database through [`pg-boss`](https://pgboss.io). There is no in-process timer: work held in memory
is lost on a restart, and every replica would run it.

**Status: implemented.** The package provides provisioning, the runtime module, transactional
enqueue, occurrence keys, workers with bounded retries and dead letters, and cron schedules. The
rules it implements are the "Background Jobs" section of the
[integration guide](../../docs/integration.md).

`@nestjs/common`, `@nestjs/core` and `pg` are peer dependencies: the application provides them.
`pg-boss` is a dependency of this package; a service never imports it.

## Two roles, two entry points

A service has two PostgreSQL roles. pg-boss needs DDL to install its schema, so the package is
split along the same line.

| Entry point     | Role                               | Runs                                                                                                              | Where it is called                        |
| --------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `provisionJobs` | `<service>_migrator` (DDL)         | Every DDL statement: schema install and migration, index builds, queue creation and update, grants to the runtime | The one-off `src/migrate.ts` container    |
| `JobsModule`    | `<service>_app` (no DDL, with RLS) | Only DML: enqueue, fetch, complete, fail, schedules, supervision                                                  | The application, once, in the root module |

The runtime starts pg-boss with `migrate: false` and `createSchema: false`: at start-up it only
reads the installed schema version. It never creates, alters or drops an object, and its
integration tests run it as a role that owns nothing and has no `CREATE` right on the database or
on the schema.

The deployment order is therefore: run the migration container, then start the service. The
runtime only starts on the exact schema version its pg-boss expects: when a release of this package
brings a newer pg-boss schema, the new release cannot start before the migration ran, and a replica
of the previous release cannot start again after it. Do not leave such a roll-out half done.

## Provisioning

```ts
// src/migrate.ts
import { provisionJobs } from '@cadenway/nest-jobs';

import { jobQueues } from './infrastructure/jobs/job-queues.js';

await provisionJobs({
  connection: { connectionString: migratorDatabaseUrl },
  appRole: 'task_app',
  queues: jobQueues,
});
```

`provisionJobs` is idempotent and safe to run on every deployment. In order, it:

1. checks that `appRole` exists, before changing anything;
2. installs the pg-boss schema, or migrates it to the version this package expects, creating the
   schema itself only when it does not exist yet (a schema created beforehand and owned by the
   migrator role works without `CREATE` on the database);
3. waits for the index builds a migration queues. pg-boss builds them in the background, one
   `CREATE INDEX CONCURRENTLY` at a time, and only an instance allowed to migrate runs them: the
   runtime is not, so they finish here. A fresh install queues none;
4. creates each dead-letter queue and each declared queue, or updates it to match its declaration.
   A queue removed from the list is left in place, with its jobs;
5. grants the application role its runtime access, in one transaction, and closes its connections.

| Option               | Default  | Meaning                                                                               |
| -------------------- | -------- | ------------------------------------------------------------------------------------- |
| `connection`         | required | Connection of the migrator role: `connectionString`, or `host` with the other fields. |
| `queues`             | required | The queue declarations, the same list given to `JobsModule`.                          |
| `appRole`            | required | Existing role of the runtime: lowercase letters, digits and underscores.              |
| `schema`             | `pgboss` | Schema of the pg-boss tables: lowercase letters, digits and underscores.              |
| `migrationTimeoutMs` | `600000` | Time the index builds of a migration get to finish. Past it the run fails; run again. |

### What the application role is granted

- `USAGE` on the schema;
- `SELECT, INSERT, UPDATE, DELETE` on all its tables: jobs, queues, schedules, the interval claims
  of the `version` table, the instance registry;
- `USAGE, SELECT` on its sequences and `EXECUTE` on its functions;
- the same as default privileges for the objects the migrator role creates later in the schema.

It is not granted `CREATE` on the schema, `TRUNCATE`, `REFERENCES` or `TRIGGER`, and it owns no
object, so it cannot run DDL on the pg-boss tables.

## Queue declarations

Queues are declared once and the list is shared by `provisionJobs` and `JobsModule`.

```ts
import type { JobQueueDeclaration } from '@cadenway/nest-jobs';

export const jobQueues: readonly JobQueueDeclaration[] = [
  { name: 'reminder.send' },
  { name: 'webhook.deliver', retryLimit: 8, retryDelaySeconds: 10 },
];
```

| Field                        | Default              | Meaning                                                                                                    |
| ---------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `name`                       | required             | Letters, digits, `_`, `-`, `.` and `/`. Names starting with `__pgboss__` are reserved.                     |
| `retryLimit`                 | `5`                  | Retries after the first attempt, 0 to 20. A job runs at most `retryLimit + 1` times.                       |
| `retryDelaySeconds`          | `30`                 | Base delay before a retry, in whole seconds.                                                               |
| `retryBackoff`               | `true`               | Exponential backoff with jitter. `false` waits exactly `retryDelaySeconds` each time.                      |
| `retryDelayMaxSeconds`       | `3600`               | Ceiling of the backoff delay. Only accepted with `retryBackoff`.                                           |
| `deadLetter`                 | `<name>.dead-letter` | Queue that receives a job after its last failed attempt. May be shared; cannot be a declared queue.        |
| `deadLetterRetentionSeconds` | `1209600` (14 days)  | Time a dead letter is kept. Queues sharing a dead-letter queue must agree on it.                           |
| `expireInSeconds`            | `900` (15 minutes)   | Time a handler may run before the attempt is failed, 1 to 86400.                                           |
| `retentionSeconds`           | `1209600` (14 days)  | Time a job may wait without being started before it is deleted, counted again at each retry.               |
| `deleteAfterSeconds`         | `604800` (7 days)    | Time a finished job row is kept. `0` keeps finished rows forever. It bounds the occurrence key, see below. |

A changed declaration reaches the database at the next provisioning run. Jobs already stored keep
the retry policy they were enqueued with. When a stored queue differs from the declaration the
runtime was given, start-up logs a warning that names the differing settings.

## Runtime module

```ts
import { Module } from '@nestjs/common';
import { JobsModule } from '@cadenway/nest-jobs';

@Module({
  imports: [
    JobsModule.forRootAsync({
      inject: [Configuration],
      useFactory: (configuration: Configuration) => ({
        connection: { connectionString: configuration.databaseUrl },
        queues: jobQueues,
      }),
    }),
  ],
})
export class AppModule {}
```

`JobsModule.forRoot(options)` takes the same options directly. The module is global: inject
`JobsService` anywhere. Import it once.

| Option              | Default           | Meaning                                                                                                    |
| ------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `connection`        | required          | Connection of the application role: `connectionString`, or `host` with the other fields.                   |
| `queues`            | required          | The queue declarations. Only declared queues accept jobs, workers and schedules.                           |
| `schema`            | `pgboss`          | Schema of the pg-boss tables, the one given to `provisionJobs`.                                            |
| `runInOrganization` | calls the handler | `(organizationId, work) => Promise<void>`: wraps each handler call in the organization context of its job. |
| `shutdownTimeoutMs` | `30000`           | Time running handlers get to finish at shutdown, at least 1000.                                            |

A default never changes without a major release.

**Connections.** pg-boss owns a pool of two connections, apart from the application pool. The size
is fixed on purpose: jobs must not take connections away from requests.

**Start-up.** The service starts with the module and fails fast, with a `JobsNotProvisionedError`,
when the schema is missing or at another version, when the connected role lacks a right on it, or
when a declared queue or its dead-letter queue does not exist. The message says what is missing.
The fix is always to run `provisionJobs`. Invalid options are refused before any connection opens.

**Shutdown.** In `beforeApplicationShutdown` the module stops fetching, waits `shutdownTimeoutMs`
for running handlers, fails the attempts still running after that so they are retried later, and
closes its pool. Call `app.enableShutdownHooks()` so a termination signal reaches it.

## Enqueue in the use case transaction

```ts
await this.jobs.enqueue(tx, 'reminder.send', { reminderId, occurrence });
```

`tx` is the transaction scope of the use case, typed structurally so this package does not depend
on `@cadenway/nest-common`:

```ts
interface JobsTransaction {
  readonly client: { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };
  readonly organizationId: string | null;
}
```

The job row is inserted through `tx.client`, a `pg` client inside the open transaction: **the job
exists if and only if the transaction commits**. A rolled-back transaction leaves no job, and a
worker cannot see the job before the commit. A failed insert aborts the caller's transaction, like
any failed statement in it.

The stored data is an envelope `{ organizationId, payload }`. The payload must be JSON-serializable
and is given back to the handler after a JSON round trip. The envelope is a stored format: fields
are only ever added to it.

`enqueue` returns `{ jobId, duplicate }`.

## Occurrence key

```ts
const result = await this.jobs.enqueue(
  tx,
  'reminder.send',
  { reminderId, occurrence },
  { occurrenceKey: `${reminderId}:${occurrence}` },
);
// result.duplicate === true: the occurrence was already enqueued, nothing was inserted.
```

With an occurrence key the job id is derived from the queue and the key: the first 122 bits of the
SHA-256 of the JSON array `[queue, occurrenceKey]`, as a version 8 UUID. The job table has a
primary key on `(queue, id)` and pg-boss inserts with `ON CONFLICT DO NOTHING`, so a second enqueue
of the same pair inserts nothing and returns `duplicate: true` with the id of the existing job.
Two concurrent transactions are serialized by the primary key: the second waits for the first and
is a duplicate if the first commits.

**How long it holds: for as long as the first job row exists**, whatever its state.

| State of the first job                 | The row is kept                                            |
| -------------------------------------- | ---------------------------------------------------------- |
| Waiting, or waiting for a retry        | `retentionSeconds` after it was last due (default 14 days) |
| Running                                | Until it finishes                                          |
| Completed, or failed and dead-lettered | `deleteAfterSeconds` after it finished (default 7 days)    |

Rows are deleted by a maintenance pass that runs at most once a day per queue, so a row can live up
to a day longer. `deleteAfterSeconds: 0` keeps finished rows, and the guarantee, forever, at the
cost of a table that only grows. An enqueue that rolled back holds nothing.

The key is therefore a guard against double enqueue within that window, not a ledger. **The
business table stays the source of truth** (`due_at`, `sent_at`): a schedule claims due rows with
`FOR UPDATE SKIP LOCKED` and marks them, and the handler checks the row before acting. Without a
key, every enqueue creates a job.

## Workers

```ts
@Injectable()
export class ReminderWorker implements OnApplicationBootstrap {
  public constructor(private readonly jobs: JobsService) {}

  public async onApplicationBootstrap(): Promise<void> {
    await this.jobs.work<ReminderPayload>('reminder.send', async (job) => {
      // job: { id, queue, payload, organizationId, attempt }
    });
  }
}
```

Registration is explicit. The handler receives one job: its `id` (stable across attempts), `queue`,
`payload`, `organizationId` (the one of the enqueuing transaction; `null` for a scheduled job) and
`attempt` (1 for the first run). Each call is wrapped in `runInOrganization`. Resolving completes
the job; rejecting fails the attempt.

| Option                   | Default | Meaning                                                     |
| ------------------------ | ------- | ----------------------------------------------------------- |
| `concurrency`            | `1`     | Jobs of the queue this process handles at the same time.    |
| `pollingIntervalSeconds` | `2`     | Seconds between two fetches of an idle queue, at least 0.5. |

The module is global, so it is started before the `onModuleInit` and `onApplicationBootstrap` hooks
of the modules that register workers.

## Retries and dead letters

A handler that rejects, or runs longer than `expireInSeconds`, fails the attempt. The job is tried
again after a delay, up to `retryLimit` times:

- with backoff (default), the delay before retry `n` is drawn at random between
  `retryDelaySeconds * 2^(n-1)` and `retryDelaySeconds * 2^n`, capped by `retryDelayMaxSeconds`.
  With the defaults: 30 to 60 seconds, then 1 to 2 minutes, up to 8 to 16 minutes before the fifth
  retry;
- without backoff, exactly `retryDelaySeconds`.

When the last attempt fails, the job row stays in its queue in the `failed` state and a copy is
inserted in the dead-letter queue, with a new id and the origin recorded (`source_name`,
`source_id`, the last error in `source_output`). Nothing consumes a dead-letter queue: a dead letter
waits there for `deadLetterRetentionSeconds`, then is deleted. Inspecting or replaying dead letters
is an operator action in SQL or with the pg-boss tooling; this package exposes no API for it yet.

**Logs.** Through the NestJS `Logger`, context `JobsService`: a rejected attempt that will be
retried is a warning, a rejected last attempt is an error that names the job, the queue, the
attempt count and the dead-letter queue. A log line carries the job id and the name and message of
the error, **never the payload**. pg-boss errors and warnings are logged with their message only,
without the SQL values attached to them.

## Schedules

```ts
await this.jobs.schedule('digest.daily', '0 8 * * *', {
  timeZone: 'Europe/Paris',
  payload: { kind: 'daily' },
  key: 'daily',
});
```

| Option     | Default   | Meaning                                                                                    |
| ---------- | --------- | ------------------------------------------------------------------------------------------ |
| `timeZone` | required  | IANA time zone the expression is evaluated in, such as `Europe/Paris` or `UTC`.            |
| `payload`  | `null`    | Payload of every job the schedule creates.                                                 |
| `key`      | empty key | Distinguishes several schedules on one queue. The same queue and key replace the schedule. |

The time zone is mandatory and validated: a missing value, an unknown name or a fixed offset such
as `+02:00` is refused. A schedule never follows the local time of the server. The expression has
five fields, or six with seconds.

A schedule is a row of the `schedule` table, written with plain DML: **the application role
registers it**, no migration is needed, and every replica can call `schedule` at start-up. One job
is created per occurrence whatever the number of replicas, with a resolution of one minute.
Schedules are evaluated every 30 seconds, so the job appears up to about 40 seconds after the
occurrence. A scheduled job has `organizationId: null`.

A schedule stays in the database until `unschedule(queue, key?)` removes it: deleting the
`schedule` call from the code does not stop it. Occurrences that came due while no replica was
running are not caught up.

## Guarantees and limits

- **At least once.** A job can run again after a crash, a timeout, a shutdown or a lost
  connection. Every handler is idempotent: "never twice" cannot be promised over SMTP or HTTP. Use
  the job id or a business key as the idempotency key of the side effect.
- **A crashed attempt is retried late, and silently.** A job whose process died stays `active`
  until `expireInSeconds` has passed; the supervision pass, which runs every minute on one replica,
  then fails the attempt and applies the retry policy. The warning and error logs above are emitted
  when a handler rejects in a live process: an attempt failed by expiration, in process or by
  supervision, is retried and dead-lettered the same way but produces no log line from this
  package. Watch the depth of the dead-letter queues.
- **No DDL at run time, so no index rebuild.** pg-boss can rebuild bloated indexes, which needs
  their ownership; the runtime has `reindex` off and logs the `index_bloat` warning instead. The
  statistics history and the warning history of pg-boss, which need partitions, are off too.
- **Not exposed yet:** delayed enqueue (`startAfter`), priorities, batches, dead-letter replay,
  queue statistics, LISTEN/NOTIFY wake-ups. A worker sees a new job at its next poll.
- **The instance registry.** pg-boss records each running instance in its `instance` table: host
  name, process id, version, pool counts. No connection detail is stored.
- **Queue policy.** Queues are created with the pg-boss `standard` policy. Provisioning refuses an
  existing queue of another policy.

## Tests

Unit specs (`*.spec.ts`) cover the pure logic; integration specs (`*.int-spec.ts`) run against a
disposable PostgreSQL from Testcontainers, on the image tag cadenway-ops pins, with a migrator role
and an application role that has no DDL right.

```bash
pnpm test packages/nest-jobs
pnpm test:integration packages/nest-jobs   # needs Docker
```
