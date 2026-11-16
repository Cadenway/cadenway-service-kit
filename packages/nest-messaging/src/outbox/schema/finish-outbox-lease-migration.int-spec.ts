import type { PoolClient, QueryResult } from 'pg';
import { expect, it } from 'vitest';

import { startTestDatabase, type TestDatabase } from '../../testing/postgres.js';
import { finishOutboxLeaseMigration } from './finish-outbox-lease-migration.js';

it('finishes and safely reruns the expansion of a legacy outbox', async () => {
  const database: TestDatabase = await startTestDatabase();
  try {
    await database.admin.query(`
      create table public.outbox_events (
        id uuid primary key default uuidv7(),
        status text not null default 'pending',
        constraint outbox_events_status_check check (status in ('pending', 'sent', 'failed'))
      );
      insert into public.outbox_events default values;
      alter table public.outbox_events
        add column lease_token uuid,
        add column lease_expires_at timestamptz,
        drop constraint outbox_events_status_check,
        add constraint outbox_events_status_check
          check (status in ('pending', 'leased', 'sent', 'failed')) not valid,
        add constraint outbox_events_lease_check check (
          (status = 'leased' and lease_token is not null and lease_expires_at is not null)
          or (status <> 'leased' and lease_token is null and lease_expires_at is null)
        ) not valid;
      insert into public.outbox_events default values;
    `);
    const client: PoolClient = await database.admin.connect();
    try {
      // A failed concurrent build leaves a catalog entry that must be removed before retrying.
      await expect(
        client.query(
          'create unique index concurrently outbox_events_lease_expiry_index on public.outbox_events (status)',
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await finishOutboxLeaseMigration(client);
      await finishOutboxLeaseMigration(client);
    } finally {
      client.release(true);
    }
    const applied: QueryResult<{ ready: boolean }> = await database.admin.query(`
      select (
        (select indisvalid from pg_index
          where indexrelid = 'public.outbox_events_lease_expiry_index'::regclass)
        and (select count(*) = 2 from pg_constraint
          where conrelid = 'public.outbox_events'::regclass and convalidated and conname in
          ('outbox_events_status_check', 'outbox_events_lease_check'))
        and (select count(*) = 2 from public.outbox_events where status = 'pending')
      ) as ready
    `);
    expect(applied.rows).toEqual([{ ready: true }]);
  } finally {
    await database.stop();
  }
});
