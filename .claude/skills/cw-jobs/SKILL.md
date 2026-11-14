---
name: cw-jobs
description: "How a Cadenway service runs durable background jobs with @cadenway/nest-jobs: a job enqueued in the use case transaction, occurrence keys, retries, dead letters, schedules. Load it before adding a job or a schedule."
---

# Background jobs

Jobs live in the service's own PostgreSQL database, through `@cadenway/nest-jobs` (`pg-boss`). There
is no in-process timer: work held in memory is lost on a restart, and every replica would run it.

| Concern | Rule |
| --- | --- |
| Enqueue | In the transaction of the use case: the job exists if and only if the data does. `JobsService.enqueue(tx, ...)` takes the scope of the tenant or system transaction runner of `@cadenway/nest-common/database` |
| Source of truth | The business table (`due_at`, `sent_at`), not the queue: a schedule claims due rows with `FOR UPDATE SKIP LOCKED` |
| Occurrence key | A unique key per occurrence, such as `(reminder_id, occurrence)`, makes a second run a no-op |
| Sends | One job per e-mail or webhook delivery; the idempotency key is the delivery id |
| Retries | Bounded, with exponential backoff; then the dead-letter queue and an error log |
| Schedules | Cron with an explicit time zone, never the server's local time |
| Guarantee | At least once. Every handler is idempotent: "never twice" cannot be promised over SMTP or HTTP |
| Connections | A pool of two, apart from the application pool |
| Roles | pg-boss's own schema is installed, migrated and granted by `provisionJobs`, called from the migration entry point as `<svc>_migrator`: it holds every DDL statement, creates the declared queues and their dead-letter queues, and grants `<svc>_app` data access only. The service runs its jobs as `<svc>_app`, without any DDL right, and refuses to start when the schema or a queue was not provisioned |

## What runs as a job

- Reminders, daily digests and due-date alerts.
- Purges: the trash, the audit log, expired sessions, codes and links.
- Outgoing webhook deliveries and their retries.
