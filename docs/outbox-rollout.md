# Roll out the leased outbox

Each service owns its database, the Drizzle schema it uses and its migration history.
Apply the expansion independently in Identity, Organization, Task, Document, Storage,
Notification, Automation, Integration, Search and Billing. The gateways have no outbox
table to migrate.

## Expand before enabling the relay

1. Add the nullable `lease_token uuid` and `lease_expires_at timestamptz` columns to
   `public.outbox_events`. Expand the status check to allow `leased` and add a check
   that requires both lease fields for that status and neither for other statuses.
   Keep the expansion transaction short and retry lock contention during deployment.
2. Build the partial index `outbox_events_lease_expiry_index` on
   `(lease_expires_at, id) WHERE status = 'leased'`. On an existing table, build it
   concurrently outside the Drizzle transaction. A cancelled concurrent build can
   leave an invalid index. Check validity before enabling the relay and retry the
   build through the migrator. Call `finishOutboxLeaseMigration(client)` from
   `@cadenway/nest-messaging/outbox/schema` on the dedicated migrator connection
   after Drizzle commits. This call also validates both checks.
3. Retain the old status behavior during expansion. The deployed writer still
   inserts `pending`, and the historic relay still selects `pending`. Verify the
   additive migration with the previous image before releasing the new runtime.
   Use the application role for the relay and retain the table's existing RLS policy.

## Activate or roll back a process

Deploy the writer before enabling the leased relay. An independently deployed relay
uses the same service image, the owning service's database and NATS credentials, and
an internal readiness check. Keep its replica count at zero during the expansion.
Replace the legacy module's implicit deduplicator with `PostgresEventDeduplicationModule`
in each consuming process that relied on it.
Disable and drain the integrated relay before scaling up the dedicated one. Confirm
that the oldest pending event gets newer and that publication failures and expired
leases stay within the measured baseline.

Keep the writer active during a rollback. Stop the leased relay, allow in-flight work
to settle, wait for remaining leases to expire, and recover expired leases in bounded
transactions through `recoverExpiredOutboxLeases`. Check that no row remains
`leased`, then enable the historic relay. Leave the new columns, checks and index in
place. Recovery can redeliver an event acknowledged by the broker before a worker
crashed. It reuses the same event ID, and the consumer still owns deduplication.
