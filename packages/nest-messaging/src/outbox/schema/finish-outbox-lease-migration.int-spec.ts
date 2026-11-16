import { SystemTransactionRunner, type DatabaseSchema } from '@cadenway/nest-common/database';
import pg, { type PoolClient, type QueryResult } from 'pg';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EventPublisher } from '../../publisher/event-publisher.js';
import { startTestDatabase, type TestDatabase } from '../../testing/postgres.js';
import { waitFor } from '../../testing/wait.js';
import { LeasedOutboxRelay } from '../relay/leased/leased-outbox-relay.js';
import { resolveOutboxRelayOptions } from '../relay/leased/outbox-relay-options.js';
import { finishOutboxLeaseMigration } from './finish-outbox-lease-migration.js';

const CREATE_EXPIRY_INDEX: string = `create index concurrently outbox_events_lease_expiry_index
  on public.outbox_events (lease_expires_at, id) where status = 'leased'`;

describe('outbox lease migration', () => {
  let database: TestDatabase;
  let appPool: pg.Pool;

  beforeAll(async () => {
    database = await startTestDatabase();
    appPool = new pg.Pool({ connectionString: database.appUrl });
    return async (): Promise<void> => {
      try {
        await appPool.end();
      } finally {
        await database.stop();
      }
    };
  });

  beforeEach(async () => {
    await database.migrate(
      [
        `drop table if exists public.outbox_events;
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
        insert into public.outbox_events default values;`,
      ],
      [],
    );
  });

  async function finish(): Promise<void> {
    const client: PoolClient = await database.migrator.connect();
    try {
      await finishOutboxLeaseMigration(client);
    } finally {
      client.release(true);
    }
  }

  async function expectRelayRefusal(): Promise<void> {
    const publishEnvelope = vi.fn<EventPublisher['publishEnvelope']>();
    const worker = new LeasedOutboxRelay(
      new SystemTransactionRunner<DatabaseSchema>(appPool),
      { publishEnvelope } as unknown as EventPublisher,
      resolveOutboxRelayOptions(),
    );
    try {
      await expect(worker.onApplicationBootstrap()).rejects.toThrow('before enabling the relay');
      expect(publishEnvelope).not.toHaveBeenCalled();
    } finally {
      await worker.beforeApplicationShutdown();
    }
  }

  it('repairs an interrupted expiry index build and safely reruns the expansion', async () => {
    const client: PoolClient = await database.migrator.connect();
    const blocker: PoolClient = await database.admin.connect();
    try {
      const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
      const pid: number | undefined = rows[0]?.pid;
      await blocker.query('begin');
      await blocker.query('lock table public.outbox_events in row exclusive mode');

      // The concurrent build creates the expected catalog entry before waiting for writers.
      const canceled = expect(client.query(CREATE_EXPIRY_INDEX)).rejects.toMatchObject({
        code: '57014',
      });
      await waitFor(async () => {
        const progress: QueryResult = await database.admin.query(
          `select 1 from pg_stat_progress_create_index
           where pid = $1 and phase = 'waiting for writers before build'`,
          [pid],
        );
        return progress.rowCount === 1;
      });
      await database.admin.query('select pg_cancel_backend($1)', [pid]);
      await canceled;
    } finally {
      try {
        await blocker.query('rollback');
      } finally {
        blocker.release(true);
        client.release(true);
      }
    }

    const invalid = await database.admin.query(
      'select indisvalid from pg_index where indexrelid = $1::regclass',
      ['public.outbox_events_lease_expiry_index'],
    );
    expect(invalid.rows).toEqual([{ indisvalid: false }]);
    await finish();
    await finish();

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
  });

  it('refuses to start when the status check is unvalidated or absent', async () => {
    await database.migrator.query(CREATE_EXPIRY_INDEX);
    await database.migrator.query(
      'alter table public.outbox_events validate constraint outbox_events_lease_check',
    );
    await expectRelayRefusal();
    await database.migrator.query(
      'alter table public.outbox_events drop constraint outbox_events_status_check',
    );
    await expectRelayRefusal();
  });

  it.each([
    "(lease_expires_at) where status = 'leased'",
    "(lease_expires_at, id) where status = 'pending'",
  ])('keeps a valid divergent index and refuses activation for %s', async (definition) => {
    await database.migrator.query(
      `create index outbox_events_lease_expiry_index on public.outbox_events ${definition};
       alter table public.outbox_events
         validate constraint outbox_events_status_check,
         validate constraint outbox_events_lease_check;`,
    );
    const index = (): Promise<QueryResult<{ oid: string }>> =>
      database.admin.query(
        `select 'public.outbox_events_lease_expiry_index'::regclass::oid::text as oid`,
      );
    const before = await index();
    await expect(finish()).rejects.toThrow('expiry index differs from the expected definition');
    expect((await index()).rows).toEqual(before.rows);
    await expectRelayRefusal();
  });
});
