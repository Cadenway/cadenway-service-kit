import type { PoolClient, QueryResult } from 'pg';

const MIGRATION_LOCK: string = 'cadenway:outbox-lease-migration';

type IndexState = Readonly<{ valid: boolean; belongs_to_outbox: boolean }>;

/**
 * Completes a service's additive outbox migration after its Drizzle transaction commits.
 * The caller supplies a dedicated migrator session and closes or releases it afterwards.
 *
 * @param {PoolClient} client - Connected PostgreSQL session outside a transaction.
 * @returns {Promise<void>} Resolves after the index and both checks are valid.
 */
export async function finishOutboxLeaseMigration(client: PoolClient): Promise<void> {
  const lock: QueryResult<{ acquired: boolean }> = await client.query(
    'select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired',
    [MIGRATION_LOCK],
  );
  if (lock.rows[0]?.acquired !== true) {
    throw new Error(
      'Another migrator is finalizing the outbox lease expansion. Retry after it ends.',
    );
  }

  try {
    const index: QueryResult<IndexState> = await client.query(
      `select indisvalid as valid, indrelid = 'public.outbox_events'::regclass as belongs_to_outbox
         from pg_catalog.pg_index
        where indexrelid = to_regclass('public.outbox_events_lease_expiry_index')`,
    );
    const existing: IndexState | undefined = index.rows[0];
    if (existing !== undefined && !existing.belongs_to_outbox) {
      throw new Error('The outbox lease expiry index belongs to another table.');
    }
    if (existing?.valid === false) {
      await client.query('drop index concurrently public.outbox_events_lease_expiry_index');
    }
    if (existing?.valid !== true) {
      await client.query(
        `create index concurrently outbox_events_lease_expiry_index
           on public.outbox_events (lease_expires_at, id) where status = 'leased'`,
      );
    }
    await client.query(
      `alter table public.outbox_events
         validate constraint outbox_events_status_check,
         validate constraint outbox_events_lease_check`,
    );
  } finally {
    await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [MIGRATION_LOCK]);
  }
}
