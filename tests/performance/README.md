# Outbox load check

This check runs the actual compiled relay against a disposable PostgreSQL 18 container. The
publisher acknowledges each event after 50 ms. A local HTTP endpoint shares the same pool and
performs `SELECT 1` on every request. Each mode executes three runs of 120 committed events,
using a four-connection pool and the same container CPU and memory limits.

```shell
node tests/performance/outbox.mjs baseline
# Build the candidate after recording the baseline.
node tests/performance/outbox.mjs candidate
```

The baseline command writes `baseline.json` in this directory. An optional third argument names
another baseline file. Run the candidate on the same host with the same Node version and settings.
The candidate exits unsuccessfully below 1.5 times the reference throughput or above 110% of its
HTTP p95. Each run reports throughput, HTTP p95 and p99, transaction p95, oldest backlog age,
peak active and waiting pool connections, and the benchmark process's peak resident memory.
The report stores the tested relay's SHA-256 so a reference can be tied to its build.

The PostgreSQL container is limited to one CPU and 512 MiB. The benchmark process runs on the host
without a CPU or memory quota. HTTP is a local pool-contention probe, so its latency does not
represent a service's authenticated business endpoints. The publisher simulates acknowledgement
latency and does not exercise NATS, event validation, consumer delivery, or broker failures.
The backlog age is sampled after each relay pass. Run staging load checks against the actual Task
API and JetStream before treating these figures as deployment evidence.

## Jobs roles

After building the kit, run `node tests/performance/jobs.mjs [report.json]`. This starts PostgreSQL with
`pg_stat_statements`, provisions a queue, and compares the number of worker polling queries
with one and two producer-only contexts. It then drains 48 jobs with one and two independent
workers, three times each, under the same total four-connection worker budget. Each handler
simulates a 50 ms SMTP call. The command fails if adding a producer increases worker polling
or if adding a worker does not increase mean throughput.
The optional path saves the measured JSON report.

The SMTP call is a delay in the handler. Run staging tests with an actual SMTP test server and
the Notification application before using these figures to size production.
