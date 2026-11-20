# @cadenway/nest-jobs

Durable background jobs for the Cadenway NestJS services, kept in each service's own PostgreSQL
database through [`pg-boss`](https://pgboss.io). There is no in-process timer: work held in memory
is lost on a restart, and every replica would run it.

**Status: implemented.** The package provides provisioning, the runtime module, transactional
enqueue, occurrence keys, workers with bounded retries and dead letters, and cron schedules. The
rules it implements are the "Background Jobs" section of the
[integration guide](../../docs/integration.md).

`@nestjs/common`, `@nestjs/core` and `pg` are peer dependencies: the application provides them.
`pg-boss` is a dependency of this package, pinned to one exact version; a service never imports it.

## Two roles, two entry points

A service has two PostgreSQL roles. pg-boss needs DDL to install its schema, so the package is
split along the same line.

Use `@cadenway/nest-jobs/provisioning` from migration processes and
`@cadenway/nest-jobs/runtime` from application processes. Internally, `jobs/` holds the
declarations shared by both paths and `schema/` holds the schema contract. The package root
remains the compatibility entry for `JobsModule`, `JobsService`, and `provisionJobs`.

| Entry point         | Role                               | Runs                                                                                                              | Where it is called                                               |
| ------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `provisionJobs`     | `<service>_migrator` (DDL)         | Every DDL statement: schema install and migration, index builds, queue creation and update, grants to the runtime | The one-off `src/migrate.ts` container                           |
| `JobsRuntimeModule` | `<service>_app` (no DDL, with RLS) | Only DML for the selected capabilities: enqueue, work, schedules and supervision                                  | The application or a dedicated process, once, in the root module |

The runtime checks the schema version, the application role and the declared queues before it
starts pg-boss with `migrate: false` and `createSchema: false`. The integration tests use a role
with no ownership or `CREATE` right on the database or schema. A role that can create objects in
the pg-boss schema is refused by default.

The deployment order is therefore: run the migration container, then start the service. The
runtime only starts on the exact schema version its pg-boss expects: when a release of this package
brings a newer pg-boss schema, the new release cannot start before the migration ran, and a replica
of the previous release cannot start again after it. Do not leave such a roll-out half done.

**The pg-boss version is pinned.** The runtime depends on the exact schema version and on two exact
error messages of pg-boss, so `package.json` names one version, not a range. A pg-boss bump is a
release of the kit with a migration note: read its schema changes, run the provisioning, then
deploy.

## Connection

Both entry points take the same `connection` object: the migrator role for `provisionJobs`, the
application role for `JobsRuntimeModule`.

| Field              | Default                                       | Meaning                                               |
| ------------------ | --------------------------------------------- | ----------------------------------------------------- |
| `connectionString` | none                                          | PostgreSQL URI, with the user and the database in it. |
| `host`             | none; required without `connectionString`     | Server host name.                                     |
| `user`             | none; required without `connectionString`     | Role to connect as.                                   |
| `database`         | none; required without `connectionString`     | Database name.                                        |
| `port`             | the driver's: `PGPORT`, then `5432`           | Server port.                                          |
| `password`         | the driver's: `PGPASSWORD`, the password file | Password of the role. Never logged.                   |
| `ssl`              | the driver's: `PGSSLMODE`, then no TLS        | `true`, or the TLS options of Node.js.                |

Without a `connectionString`, `host`, `user` and `database` are required together: the role and
the database are never read from the `PG*` environment variables, which could be those of the
other role. A connection URI is handed to the driver as is, and the parts it does not carry fall
back on the same variables: write the user and the database in it.

## Provisioning

```ts
// src/migrate.ts
import { provisionJobs } from '@cadenway/nest-jobs/provisioning';

import { jobQueues } from './infrastructure/jobs/job-queues.js';

await provisionJobs({
  connection: { connectionString: migratorDatabaseUrl },
  appRole: 'task_app',
  queues: jobQueues,
});
```

`provisionJobs` is idempotent and safe to run on every deployment; two runs started together both
succeed. In order, it:

1. checks that `appRole` exists, before changing anything;
2. on a first install, creates the schema itself when it does not exist yet (a schema created
   beforehand and owned by the migrator role works without `CREATE` on the database) and closes it
   to every role but its owner and the migrator role (see below);
3. on an installed schema, refuses to go on when the stored schema is newer than the pg-boss
   version of this package, older than its background index builds (schema version 27, pg-boss
   12.6), or when the queue table holds rows this package does not create (see the guard below);
   then holds the index builds of pg-boss back;
4. installs the pg-boss schema, or migrates it to the version this package expects, checks `bam`
   and `version` again and only then releases the index builds;
5. waits for the index builds a migration queues. pg-boss builds them in the background, one
   `CREATE INDEX CONCURRENTLY` at a time, and only an instance allowed to migrate runs them: the
   runtime is not, so they finish here. A fresh install queues none; a migration waits up to 10
   seconds more for the first pass, since the builds are released after pg-boss started;
6. creates each dead-letter queue and each declared queue, or updates it to match its declaration.
   A queue removed from the list is left in place, with its jobs and its schedules;
7. grants the application role its runtime access, in one transaction, and closes its connections.

| Option               | Default  | Meaning                                                                                                   |
| -------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `connection`         | required | Connection of the migrator role, see above.                                                               |
| `queues`             | required | The queue declarations, the same list given to `JobsModule`.                                              |
| `appRole`            | required | Existing role of the runtime: lowercase letters, digits and underscores.                                  |
| `schema`             | `pgboss` | Schema of the pg-boss tables: lowercase letters, digits and underscores; not `public` or a system schema. |
| `migrationTimeoutMs` | `600000` | Time the index builds of a migration get to finish, at least 1000. Past it the run fails; run it again.   |

The schema must be a schema of its own: the grants below cover every table of it.

### What the application role is granted

- `USAGE` on the schema;
- `SELECT, INSERT, UPDATE, DELETE` on its tables: jobs, queues, schedules, the instance registry;
- on `version`: `SELECT`, and `UPDATE` on the claim columns the runtime stamps (`cron_on`,
  `flow_on`, `reindex_on`, `monitor_backoff_on`) only. The role cannot change the stored schema
  version, which decides the migrations the next provisioning runs, nor the index-build claim
  `bam_on`, which only an instance that migrates stamps;
- on `bam`: nothing. That table lists statements pg-boss executes verbatim as the role that
  migrates; the runtime never reads or writes it;
- `USAGE, SELECT` on its sequences and `EXECUTE` on its functions.

It is not granted `CREATE` on the schema, `TRUNCATE`, `REFERENCES` or `TRIGGER`, and it owns no
object, so it cannot run DDL on the pg-boss tables. This package sets no default privilege: a table
that a later pg-boss version adds is granted by the provisioning run that creates it.

### Platform default privileges

cadenway-ops gives each application role default privileges on everything its migrator role
creates (`ALTER DEFAULT PRIVILEGES FOR ROLE <service>_migrator`: `USAGE` on schemas, data access
to tables, `USAGE, SELECT` on sequences). Those apply to the pg-boss objects too, the moment
pg-boss creates them, and a per-schema default privilege cannot take a global one back. Left
alone, the application role would reach `bam` while the provisioning that runs its rows is still
going. The provisioning closes that window itself:

- **First install.** `provisionJobs` creates the schema, rather than letting pg-boss do it, and in
  the same transaction revokes every privilege on it from every role but its owner and the
  migrator role, `PUBLIC` included. pg-boss then installs in a schema the application role cannot
  use: the default privileges still land on the new tables, but a table is out of reach without
  the usage of its schema. They are revoked from `bam` and `version` before any index build, and
  the application role gets the usage of the schema in the same commit as its final grants. The
  run refuses to install when the application role can still use the schema after the revoke (a
  superuser, an owner, or a grant the migrator role cannot revoke).
- **Installed schema.** The runtime may be live, so the usage of the schema is not revoked.
  Instead, before pg-boss starts, the provisioning stamps the index-build claim `bam_on` a day
  ahead: pg-boss runs no index build until that claim is cleared. After the install or migration,
  it checks `bam` and `version` again and clears the claim in the same transaction. A migration
  can create tables, `bam` itself in the pg-boss 12.6 migration, and the default privileges open
  them at once.

On both checks, a privilege on `bam`, or a table-level write on `version`, held by a role that
cannot use the schema is revoked and the run goes on. Held by a role that can use the schema, it
means rows may have been planted: the run fails closed, executes nothing, revokes nothing, and
leaves the index builds held. Revoke the privilege, check that every pending row of `bam` is an
index build of pg-boss, then run the provisioning again. A run that stops between the hold and
the release leaves the builds held for a day at most; the next successful run releases them.

When `appRole` is the role `provisionJobs` connects as, there is no boundary to enforce: no access
is managed at all and a warning says so. Use that only on a local stack with a single role, with
`allowPrivilegedRole` on the runtime.

### The guard on the queue table

The runtime needs `INSERT` and `UPDATE` on the `queue` table, and a pg-boss migration executes DDL
built from the rows of that table that are flagged as partitioned. This package never creates a
partitioned queue, so every run refuses to continue when a row is partitioned or names another job
table than the shared one, and says which.

When a migration is pending, the application role first loses its write access to `queue`, the
rows are checked once the writes in flight have ended, and the grants give the access back at the
end of the run. During that window a running service keeps enqueuing and working jobs; only its
supervision passes and a restart fail, and they are logged. A run that fails leaves the access
closed until the next successful run.

## Queue declarations

Queues are declared once and the list is shared by `provisionJobs` and `JobsModule`.

```ts
import type { JobQueueDeclaration } from '@cadenway/nest-jobs/provisioning';

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
import { JobsRuntimeModule } from '@cadenway/nest-jobs/runtime';

@Module({
  imports: [
    JobsRuntimeModule.forRootAsync({
      inject: [Configuration],
      useFactory: (configuration: Configuration) => ({
        connection: { connectionString: configuration.databaseUrl },
        queues: jobQueues,
        capabilities: ['producer', 'scheduler'],
        poolSize: 2,
      }),
    }),
  ],
})
export class AppModule {}
```

`JobsRuntimeModule.forRoot(options)` takes the same options directly. Import the global module
once per process and select the capabilities that process owns. For a combined process use
`['producer', 'worker', 'scheduler']`. For a dedicated worker use `['worker']`, with the same
queue declarations as the application and the migrator.

| Capability  | Injectable API      | Responsibility                                                                                                                              |
| ----------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `producer`  | `JobProducer`       | `enqueue` inserts through the use case's transaction. On its own it holds no persistent jobs connections and starts no pg-boss loop.        |
| `worker`    | `JobWorkerRegistry` | `work` starts acquisition for a declared queue and runs its handlers.                                                                       |
| `scheduler` | `JobScheduler`      | `schedule` and `unschedule` change durable cron declarations. The runtime evaluates crons, supervises jobs and monitors dead-letter queues. |

The injectable APIs are classes that can be passed as Nest tokens. Calling an operation outside
the selected capabilities fails explicitly. Run a scheduler in the deployment even when all
workers are separate. It handles expired attempts and cron events. Worker-only replicas leave
supervision and dead-letter monitoring to the scheduler.

| Option                           | Default           | Meaning                                                                                                            |
| -------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `connection`                     | required          | Connection of the application role, see above.                                                                     |
| `queues`                         | required          | The queue declarations. Only declared queues accept jobs, workers and schedules.                                   |
| `capabilities`                   | required          | Distinct process capabilities. At least one is required.                                                           |
| `poolSize`                       | required          | Maximum persistent jobs connections per process, at least 1. Worker and scheduler share a pool when combined.      |
| `schema`                         | `pgboss`          | Schema of the pg-boss tables, the one given to `provisionJobs`.                                                    |
| `runInOrganization`              | calls the handler | `(organizationId, work) => Promise<void>`: wraps each handler call in the organization context of its job.         |
| `shutdownTimeoutMs`              | `30000`           | Time running handlers get to finish at shutdown, at least 1000.                                                    |
| `deadLetterCheckIntervalSeconds` | `60`              | Whole seconds between checks of retained dead letters, up to 2,147,483. `0` turns the watch off.                   |
| `allowPrivilegedRole`            | `false`           | Lets the runtime start as a role that can create objects in the schema. For a local stack with a single role only. |

A default never changes without a major release.

**Connections.** The worker and scheduler use one pg-boss pool apart from the application pool.
Size it per replica and include it in the deployment's aggregate PostgreSQL budget. Worker
`concurrency` and `pollingIntervalSeconds` control processing and polling separately from connection
capacity. Every process verifies provisioning on one temporary connection, with a 10-second
connection timeout and a 10-second timeout per query. It closes that session before enabling
its capabilities. A producer-only process then uses only the caller's transaction, including
for pg-boss queue metadata queries.

**Compatibility.** The root `JobsModule` and `JobsService` still combine the three capabilities,
with their original two-connection pool. Replace each `JobsService` injection by the relevant
capability, change the module declaration to `JobsRuntimeModule`, and switch the migration script
to `/provisioning`. Queue names, occurrence keys and the stored job format remain compatible when
the first updated replica starts beside an older replica.

**Start-up.** The service starts with the module and fails fast, with a `JobsNotProvisionedError`,
when the schema is missing or at another version, when the connected role lacks a right on it, or
when a declared queue or its dead-letter queue does not exist. The message says what is missing.
The fix is always to run `provisionJobs`. It also fails, with a plain error, when the connected
role can create objects in the pg-boss schema: that is the migrator role, an owner or a superuser,
not the application role. Invalid options are refused before any connection opens. A scheduler
logs a warning for a stored schedule whose queue is no longer declared. Dead-letter monitoring
starts in the background. A failed monitoring check is logged and retried on the configured
interval.

**Shutdown.** In `beforeApplicationShutdown` the module asks pg-boss to stop fetching and cancels
the dead-letter check in flight. The `shutdownTimeoutMs` grace starts immediately. At expiry the
runtime aborts the signals of its running handlers, reports their attempts, and rejects their worker
callbacks so pg-boss can apply the retry policy. A handler should honor its signal to stop its own
work. The shutdown hook waits for pg-boss to settle attempts and close its pool. A slow or blocked
PostgreSQL operation can extend that cleanup past the handler grace. During normal operation, the
dead-letter check uses the same timeout to cancel its query. A checkout waiting for a pool connection
follows the driver's checkout timeout and skips the query if its signal expired in the meantime.
Call `app.enableShutdownHooks()` so a termination signal reaches it.

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

Pass `{ startAfter: dueAt }`, where `dueAt` is a valid `Date`, to make the job eligible from
that instant. Enqueue still uses the caller's transaction. The worker picks up the job on a poll
after both the instant and the commit. Waiting retention starts at `dueAt`. Without `startAfter`,
the job is eligible as soon as the transaction commits.

## Occurrence key

```ts
const result = await this.jobs.enqueue(
  tx,
  'reminder.send',
  { reminderId, occurrence },
  { occurrenceKey: `${reminderId}:${occurrence}`, startAfter: dueAt },
);
// result.duplicate === true: the occurrence was already enqueued, nothing was inserted.
```

With an occurrence key the job id is derived from the queue, the organization of the transaction
scope and the key: the first 122 bits of the SHA-256 of the JSON array
`[queue, organizationId, occurrenceKey]`, as a version 8 UUID. The job table has a primary key on
`(queue, id)` and pg-boss inserts with `ON CONFLICT DO NOTHING`, so a second enqueue of the same
triple inserts nothing and returns `duplicate: true` with the id of the existing job. Two
concurrent transactions are serialized by the primary key: the second waits for the first and is a
duplicate if the first commits.

A duplicate preserves the first job's payload and start time. To schedule a new occurrence,
use a new occurrence key and have the worker verify the current business row before acting.

**The key is scoped to the organization.** A key that is not globally unique, such as
`digest:2026-11-14`, identifies one occurrence per organization: one organization cannot suppress
the job of another. A transaction scope without organization (`null`) is a scope of its own.

**The derivation is a stored format and will not change.** Changing it would let an occurrence
already enqueued be enqueued again.

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
  public constructor(private readonly jobs: JobWorkerRegistry) {}

  public async onApplicationBootstrap(): Promise<void> {
    await this.jobs.work<ReminderPayload>('reminder.send', async (job) => {
      // job: { id, queue, payload, organizationId, attempt, signal }
    });
  }
}
```

Registration is explicit, once per queue and per process: a second `work` on the same queue is
refused, raise `concurrency` instead. The handler receives one job:

| Field            | Meaning                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `id`             | Id of the job, stable across its attempts.                                                            |
| `queue`          | Queue the job was fetched from.                                                                       |
| `payload`        | Payload given to `enqueue` or `schedule`.                                                             |
| `organizationId` | Organization of the enqueuing transaction; `null` for a scheduled job.                                |
| `attempt`        | 1 for the first run, up to `retryLimit + 1`.                                                          |
| `signal`         | `AbortSignal` aborted when the attempt expires or is abandoned at shutdown: it can no longer succeed. |

Each call is wrapped in `runInOrganization`. Resolving completes the job; rejecting fails the
attempt. Pass `signal` to the calls that accept one and stop when it aborts: a handler that never
settles keeps its worker slot busy, even though its attempt was failed and the job runs again
elsewhere.

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

### What is stored about a failure

pg-boss stores the error a handler throws on the job row (`output`) and on its dead letter
(`source_output`), for `deleteAfterSeconds` and `deadLetterRetentionSeconds`. It would store the
error whole: its stack, its cause chain and every enumerable property. This package therefore
rethrows a plain error, and what is stored is `name` (`Error`), `message` (the name and the message
of the original error) and the stack of that plain error. The message is the handler's: do not put
personal data in an error message.

### Who logs what

Every line goes through the NestJS `Logger`, context `JobsService`. It carries the job id, the
queue, the attempt count and the reason, **never the payload**. pg-boss errors and warnings are
logged with their message only, without the SQL values attached to them.

| How the attempt ends                                               | Logged by                              | Line                                                            |
| ------------------------------------------------------------------ | -------------------------------------- | --------------------------------------------------------------- |
| The handler rejects                                                | The worker process, at once            | Warning when the job will be retried, error on the last attempt |
| The handler is still running at `expireInSeconds`                  | The worker process, at the expiration  | Same                                                            |
| The handler is still running at shutdown, past `shutdownTimeoutMs` | The process that shuts down            | Same                                                            |
| The process crashed; supervision fails the attempt in SQL          | Nobody, for the attempt                | None: a retry after a crash is silent                           |
| A dead-letter queue has retained jobs                              | The dead-letter watch of every replica | Error with the observed count per non-empty queue               |

The error of a last attempt names the dead-letter queue the job moves to. At startup and then
every `deadLetterCheckIntervalSeconds`, each replica checks the currently retained rows in each
declared dead-letter queue. Each check uses a read-only statement and returns at most one count
per queue. Counts are exact up to 1,000, with larger queues reported as having more than 1,000
jobs. The same retained job can appear in successive checks and on several replicas. A failed
attempt committed after a check can appear on the next one even if it has an older timestamp.
Jobs removed before a successful check do not appear in its snapshot.

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

A schedule stays in the database until `unschedule(queue, { key })` removes it: deleting the
`schedule` call from the code does not stop it. `unschedule` accepts any queue name, declared or
not, so the schedule of a queue that left the declarations can still be removed; start-up warns
about each such schedule. Occurrences that came due while no replica was running are not caught up.

## Guarantees and limits

- **At least once.** A job can run again after a crash, a timeout, a shutdown or a lost
  connection. Every handler is idempotent: "never twice" cannot be promised over SMTP or HTTP. Use
  the job id or a business key as the idempotency key of the side effect.
- **A crashed attempt is retried late.** A job whose process died stays `active` until
  `expireInSeconds` has passed; the supervision pass, which runs every minute on one replica, then
  fails the attempt and applies the retry policy. That retry is not logged; the dead letter it may
  end in is, by the dead-letter watch.
- **A deploy can use one retry.** A handler still running when `shutdownTimeoutMs` has passed has
  its attempt failed, which counts against `retryLimit` like any failure. Keep handlers shorter
  than the timeout, or make them stop on `signal`.
- **No DDL at run time, so no index rebuild.** pg-boss can rebuild bloated indexes, which needs
  their ownership; the runtime has `reindex` off and logs the `index_bloat` warning instead. The
  statistics history and the warning history of pg-boss, which need partitions, are off too.
- **Not exposed yet:** priorities, batches, dead-letter replay, queue statistics, LISTEN/NOTIFY
  wake-ups. A worker sees a new eligible job at its next poll.
- **`retryBackoff` is a boolean.** The backoff is the one of pg-boss, doubling with jitter; no
  other curve can be chosen.
- **The instance registry.** pg-boss records each running instance in its `instance` table: host
  name, process id, version, pool counts. No connection detail is stored.
- **Queue policy.** Queues are created with the pg-boss `standard` policy and are never
  partitioned. Provisioning refuses an existing queue of another kind.

## Tests

Unit specs (`*.spec.ts`) cover the pure logic; integration specs (`*.int-spec.ts`) run against a
disposable PostgreSQL from Testcontainers, on the image tag cadenway-ops pins, with a migrator role
and an application role that has no DDL right.

```bash
pnpm test packages/nest-jobs
pnpm test:integration packages/nest-jobs   # needs Docker
```
