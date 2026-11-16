import { randomUUID } from 'node:crypto';

import { SystemTransactionRunner, type DatabaseSchema } from '@cadenway/nest-common/database';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type {
  EventPublisher,
  OutgoingEvent,
  PublishedEvent,
} from '../../../publisher/event-publisher.js';
import { kitMigration, startTestDatabase, type TestDatabase } from '../../../testing/postgres.js';
import outboxEvents from '../../schema/leased-outbox-events.schema.js';
import { resolveOutboxOptions } from '../../wiring/outbox-options.js';
import { OutboxRelay } from '../outbox-relay.js';
import { LeasedOutboxRelay } from './leased-outbox-relay.js';
import { claimOutboxRows } from './outbox-lease-store.js';
import { resolveOutboxRelayOptions, type OutboxRelayOptions } from './outbox-relay-options.js';
import { recoverExpiredOutboxLeases } from './recover-expired-outbox-leases.js';

type Publish = EventPublisher['publishEnvelope'];
interface DatabaseRow {
  // #region Properties
  /** Status used to verify the persisted outcome. */
  status: string;
  lease_token: string | null;
  payload: Record<string, unknown>;
  // #endregion
}

function asPublisher(publishEnvelope: Publish): EventPublisher {
  return { publishEnvelope } as EventPublisher;
}

function acknowledged(event: OutgoingEvent): PublishedEvent {
  return { id: event.payload.id, stream: event.stream, streamSequence: 1, duplicate: false };
}

describe('lease relay with service-owned PostgreSQL and RLS', () => {
  let database: TestDatabase;
  let pool: pg.Pool;
  let system: SystemTransactionRunner<DatabaseSchema>;

  beforeAll(async () => {
    database = await startTestDatabase();
    await database.migrate(await kitMigration({ outboxEvents }), ['outbox_events']);
    // Both simulated replicas share a single connection. Holding it across publication would
    // prevent the publication callback from making a second database transaction.
    pool = new pg.Pool({ connectionString: database.appUrl, max: 1, connectionTimeoutMillis: 500 });
    system = new SystemTransactionRunner<DatabaseSchema>(pool);
  }, 120_000);

  beforeEach(async () => {
    await database.admin.query('truncate outbox_events');
  });

  afterAll(async () => {
    await pool.end();
    await database.stop();
  });

  async function insert(restricted: boolean = false): Promise<string> {
    const id: string = randomUUID();
    const payload: Record<string, unknown> = {
      id,
      occurredAt: new Date().toISOString(),
      organizationId: null,
      actor: { type: 'system', id: 'test' },
      version: 1,
      ...(restricted ? { code: 'test-code' } : {}),
    };
    await system.run(async ({ client }) => {
      await client.query(
        `insert into outbox_events (id, event_name, subject, stream, payload)
          values ($1, 'fixture.updated.v1', $2, $3, $4)`,
        [
          id,
          restricted ? 'restricted.fixture.updated.v1' : 'evt.fixture.updated.v1',
          restricted ? 'EVENTS_RESTRICTED' : 'EVENTS',
          payload,
        ],
      );
    });
    return id;
  }

  async function expire(id: string): Promise<void> {
    await database.admin.query(
      "update outbox_events set lease_expires_at = now() - interval '1 second' where id = $1",
      [id],
    );
  }

  async function read(id: string): Promise<DatabaseRow | undefined> {
    const { rows } = await database.admin.query<DatabaseRow>(
      'select status, lease_token, payload from outbox_events where id = $1',
      [id],
    );
    return rows[0];
  }

  function relay(publish: Publish, options: OutboxRelayOptions = {}): LeasedOutboxRelay {
    return new LeasedOutboxRelay(
      system,
      asPublisher(publish),
      resolveOutboxRelayOptions({ autoStart: false, ...options }),
    );
  }

  it('claims only four per replica, deduplicates local passes and releases PostgreSQL before publishing', async () => {
    const ids: string[] = [];
    for (let index: number = 0; index < 9; index += 1) {
      ids.push(await insert());
    }
    const seen = new Set<string>();
    const publish: Publish = async (event) => {
      expect(seen.has(event.payload.id)).toBe(false);
      seen.add(event.payload.id);
      const status: string | undefined = await system.run(async ({ client }) => {
        const { rows } = await client.query('select status from outbox_events where id = $1', [
          event.payload.id,
        ]);
        return (rows[0] as { status: string } | undefined)?.status;
      });
      expect(status).toBe('leased');
      return acknowledged(event);
    };
    const first = relay(publish);
    const second = relay(publish);
    const passes = await Promise.all([
      first.publishPending(),
      first.publishPending(),
      second.publishPending(),
    ]);
    expect(passes.map(({ published }) => published)).toEqual([4, 4, 4]);
    expect(seen.size).toBe(8);
    await expect(second.publishPending()).resolves.toMatchObject({ published: 1 });
    expect(seen).toEqual(new Set(ids));
  });

  it('redacts a protected payload atomically with the sent status', async () => {
    const id: string = await insert(true);
    const worker = relay((event) => {
      expect(event.payload).toMatchObject({ id, code: 'test-code' });
      return Promise.resolve(acknowledged(event));
    });
    await expect(worker.publishPending()).resolves.toMatchObject({ published: 1 });
    const row = await read(id);
    expect(row).toMatchObject({ status: 'sent', lease_token: null, payload: { $redacted: true } });
    expect(row?.payload).not.toHaveProperty('code');
  });

  it('rejects a stale acknowledgement after another replica has taken the lease', async () => {
    const id: string = await insert();
    const attempts: string[] = [];
    const second = relay((event) => {
      attempts.push(event.payload.id);
      return Promise.resolve(acknowledged(event));
    });
    const first = relay(async (event) => {
      // This ACK is lost to the database until after a replica has retried an expired lease.
      attempts.push(event.payload.id);
      await expire(id);
      await expect(second.publishPending()).resolves.toMatchObject({ published: 1 });
      return acknowledged(event);
    });
    await expect(first.publishPending()).resolves.toMatchObject({ published: 0 });
    expect(attempts).toEqual([id, id]);
    await expect(read(id)).resolves.toMatchObject({ status: 'sent', lease_token: null });
  });

  it('recovers a process crash before publishing and makes expired leases visible to the legacy relay', async () => {
    const id: string = await insert();
    await system.run(({ client }) => claimOutboxRows(client, 1, 30_000));
    const legacy = new OutboxRelay(
      system,
      asPublisher((event) => Promise.resolve(acknowledged(event))),
      resolveOutboxOptions({ relay: false }),
    );
    await expect(legacy.publishPending()).resolves.toMatchObject({ published: 0 });
    await expect(system.run((tx) => recoverExpiredOutboxLeases(tx))).resolves.toBe(0);
    await expire(id);
    await expect(system.run((tx) => recoverExpiredOutboxLeases(tx, 1))).resolves.toBe(1);
    await expect(legacy.publishPending()).resolves.toMatchObject({ published: 1 });
    await expect(read(id)).resolves.toMatchObject({ status: 'sent', lease_token: null });
  });

  it('lets unsettled leases expire when the shutdown grace ends before the acknowledgement', async () => {
    const id: string = await insert();
    let signalPublished: () => void = (): void => undefined;
    let giveAck: () => void = (): void => undefined;
    const published = new Promise<void>((resolve) => {
      signalPublished = resolve;
    });
    const pendingAck = new Promise<void>((resolve) => {
      giveAck = resolve;
    });
    const worker = relay(
      async (event) => {
        signalPublished();
        await pendingAck;
        return acknowledged(event);
      },
      { shutdownTimeoutMs: 10 },
    );
    const pass = worker.publishPending();
    try {
      await published;
      await worker.beforeApplicationShutdown();
      await expect(worker.publishPending()).rejects.toThrow('shutting down');
    } finally {
      giveAck();
    }
    await expect(pass).resolves.toMatchObject({ published: 0 });
    await expect(read(id)).resolves.toMatchObject({ status: 'leased' });
    await expire(id);
    const successor = relay((event) => Promise.resolve(acknowledged(event)));
    await expect(successor.publishPending()).resolves.toMatchObject({ published: 1 });
  });

  it('refuses publication inside an open transaction', async () => {
    const worker = relay((event) => Promise.resolve(acknowledged(event)));
    await expect(system.run(() => worker.publishPending())).rejects.toThrow(
      'outside an active transaction',
    );
  });
});
