import type { PoolClient, QueryResult } from 'pg';

import { inspectOutboxLeaseSchema } from './inspect-outbox-lease-schema.js';

/**
 * Constant MIGRATION_LOCK
 *
 * @description
 * Database advisory lock key that serializes finalization across migrator sessions.
 *
 * @type {string}
 */
const MIGRATION_LOCK: string = 'cadenway:outbox-lease-migration';

/**
 * Function finishOutboxLeaseMigration
 *
 * @description
 * Completes a service's additive outbox migration after its Drizzle transaction commits.
 * The caller supplies a dedicated migrator session and closes or releases it afterwards.
 *
 * Rebuilds an invalid index only if its definition matches the expected expiry index.
 *
 * @param {PoolClient} client - Connected PostgreSQL session outside a transaction.
 * @returns {Promise<void>} Resolves when both checks and the expected expiry index are valid.
 * @throws When another migrator holds the lock, the schema differs, or PostgreSQL rejects validation.
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
    const schema = await inspectOutboxLeaseSchema(client, 'public.outbox_events');
    if (schema === undefined) {
      throw new Error(
        'Apply the service outbox table migration before finalizing the lease expansion.',
      );
    }
    if (schema.index_state === 'divergent') {
      throw new Error(
        "The outbox lease expiry index differs from the expected definition: (lease_expires_at, id) where status = 'leased'.",
      );
    }
    if (schema.index_state === 'invalid') {
      await client.query('drop index concurrently public.outbox_events_lease_expiry_index');
    }
    if (schema.index_state !== 'valid') {
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
