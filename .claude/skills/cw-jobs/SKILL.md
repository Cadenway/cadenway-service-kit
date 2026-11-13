---
name: cw-jobs
description: "How a Cadenway service runs durable background jobs with @cadenway/nest-jobs: a job enqueued in the use case transaction, occurrence keys, retries, dead letters, schedules. Load it before adding a job or a schedule."
---

# Background jobs

Jobs live in the service's own PostgreSQL database, through `@cadenway/nest-jobs` (`pg-boss`). There
is no in-process timer: work held in memory is lost on a restart, and every replica would run it.

| Concern | Rule |
| --- | --- |
| Enqueue | In the transaction of the use case: the job exists if and only if the data does |
| Source of truth | The business table (`due_at`, `sent_at`), not the queue: a schedule claims due rows with `FOR UPDATE SKIP LOCKED` |
| Occurrence key | A unique key per occurrence, such as `(reminder_id, occurrence)`, makes a second run a no-op |
| Sends | One job per e-mail or webhook delivery; the idempotency key is the delivery id |
| Retries | Bounded, with exponential backoff; then the dead-letter queue and an error log |
| Schedules | Cron with an explicit time zone, never the server's local time |
| Guarantee | At least once. Every handler is idempotent: "never twice" cannot be promised over SMTP or HTTP |
| Connections | A pool of two, apart from the application pool |

## What runs as a job

- Reminders, daily digests and due-date alerts.
- Purges: the trash, the audit log, expired sessions, codes and links.
- Outgoing webhook deliveries and their retries.
