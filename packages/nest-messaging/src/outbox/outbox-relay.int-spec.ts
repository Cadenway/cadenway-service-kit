import {
  SystemTransactionRunner,
  TenantTransactionRunner,
  type DatabaseSchema,
  type TransactionScope,
} from '@cadenway/nest-common/database';
import {
  jetstream,
  jetstreamManager,
  type ConsumerInfo,
  type JetStreamManager,
  type StoredMsg,
  type StreamInfo,
} from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';
import type { TestingModule } from '@nestjs/testing';
import { context, ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { EventConsumers } from '../consumer/event-consumers.js';
import { EVENT_NAME_HEADER, TRACEPARENT_HEADER } from '../publisher/event-headers.js';
import {
  disableTracePropagation,
  enableTracePropagation,
  isolatedNames,
} from '../testing/application.js';
import { ATELIER_NORD, eventSchemas, taskUpdated, type TaskUpdatedV1 } from '../testing/events.js';
import { startTestNats, type TestNats } from '../testing/nats.js';
import { appendTaskUpdated, asMember, migrateOutbox, startService } from '../testing/outbox.js';
import { startTestDatabase, type TestDatabase } from '../testing/postgres.js';
import { delay, waitFor } from '../testing/wait.js';
import {
  purgeProcessedEvents,
  purgeSentOutboxEvents,
  requeueOutboxEvents,
} from './outbox-maintenance.js';
import { OutboxRelay, type RelayPass } from './outbox-relay.js';
import { OutboxWriter, type AppendedEvent } from './outbox-writer.js';

/**
 * Interface OutboxRow
 *
 * @description
 * Columns of an outbox row the specs assert on.
 */
interface OutboxRow {
  // #region Properties
  /**
   * Property id
   *
   * @description
   * Id of the event.
   *
   * @type {string}
   * @readonly
   */
  readonly id: string;

  /**
   * Property status
   *
   * @description
   * `pending` or `sent`.
   *
   * @type {string}
   * @readonly
   */
  readonly status: string;

  /**
   * Property attempts
   *
   * @description
   * Number of publish attempts.
   *
   * @type {number}
   * @readonly
   */
  readonly attempts: number;

  /**
   * Property last_error
   *
   * @description
   * Class of the last publish failure.
   *
   * @type {string | null}
   * @readonly
   */
  readonly last_error: string | null;

  /**
   * Property sent_at
   *
   * @description
   * Instant the row was marked sent.
   *
   * @type {Date | null}
   * @readonly
   */
  readonly sent_at: Date | null;
  // #endregion
}

describe('outbox relay on real PostgreSQL and NATS', () => {
  let database: TestDatabase;
  let nats: TestNats;
  let client: NatsConnection;
  let manager: JetStreamManager;

  /**
   * Function outbox
   *
   * @description
   * Reads the outbox as the superuser, oldest row first.
   *
   * @returns {Promise<OutboxRow[]>} The rows.
   */
  async function outbox(): Promise<OutboxRow[]> {
    const result: { rows: OutboxRow[] } = await database.admin.query(
      'select id, status, attempts, last_error, sent_at from outbox_events order by created_at, id',
    );
    return result.rows;
  }

  /**
   * Function allSent
   *
   * @description
   * Tells whether the outbox holds the expected number of rows and all of them are sent.
   *
   * @param {number} expected - Number of rows expected.
   * @returns {Promise<boolean>} `true` once every row is sent.
   */
  async function allSent(expected: number): Promise<boolean> {
    const rows: OutboxRow[] = await outbox();
    return rows.length === expected && rows.every((row: OutboxRow) => row.status === 'sent');
  }

  /**
   * Function stored
   *
   * @description
   * Counts the messages of a stream.
   *
   * @param {string} stream - Name of the stream.
   * @returns {Promise<number>} The number of messages stored.
   */
  async function stored(stream: string): Promise<number> {
    const info: StreamInfo = await manager.streams.info(stream);
    return info.state.messages;
  }

  beforeAll(async () => {
    enableTracePropagation();
    [database, nats] = await Promise.all([startTestDatabase(), startTestNats()]);
    await migrateOutbox(database);
    client = await nats.connect();
    manager = await jetstreamManager(client);
  });

  beforeEach(async () => {
    await database.admin.query('truncate outbox_events, processed_events, event_versions');
  });

  afterAll(async () => {
    await client.close();
    await Promise.all([database.stop(), nats.stop()]);
    disableTracePropagation();
  });

  it('publishes a committed event once and never an event whose use case rolled back', async () => {
    const application: TestingModule = await startService(database, nats, isolatedNames('commit'));
    const received: string[] = [];
    await application.get(EventConsumers).subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: (payload: TaskUpdatedV1): Promise<void> => {
        received.push(payload.taskId);
        return Promise.resolve();
      },
    });

    await expect(
      asMember(ATELIER_NORD, () =>
        application
          .get(TenantTransactionRunner)
          .run(async (tx: TransactionScope<DatabaseSchema>) => {
            await application
              .get(OutboxWriter)
              .append(tx, eventSchemas, 'task.updated.v1', taskUpdated({ taskId: 'CAD-ROLLBACK' }));
            throw new Error('use case failed');
          }),
      ),
    ).rejects.toThrow('use case failed');
    const committed: AppendedEvent = await context.with(
      trace.setSpanContext(ROOT_CONTEXT, {
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        traceFlags: TraceFlags.SAMPLED,
      }),
      () => appendTaskUpdated(application, { taskId: 'CAD-COMMIT' }),
    );
    await waitFor(() => allSent(1));
    await waitFor(() => received.length === 1);
    await delay(300);
    const message: StoredMsg | null = await manager.streams.getMessage('EVENTS_commit', {
      last_by_subj: 'evt-commit.task.updated.v1',
    });
    const rows: OutboxRow[] = await outbox();
    await application.close();

    expect(received).toEqual(['CAD-COMMIT']);
    expect(await stored('EVENTS_commit')).toBe(1);
    expect(message?.header.get('Nats-Msg-Id')).toBe(committed.id);
    expect(message?.header.get(EVENT_NAME_HEADER)).toBe('task.updated.v1');
    expect(message?.header.get(TRACEPARENT_HEADER)).toBe(
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    );
    expect(message?.json<TaskUpdatedV1>()).toMatchObject({
      id: committed.id,
      occurredAt: committed.occurredAt,
      taskId: 'CAD-COMMIT',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: committed.id, status: 'sent', attempts: 1 });
    expect(rows[0]?.sent_at).toBeInstanceOf(Date);
  });

  it('publishes again after a crash between the publish and the commit, and the consumer handles the event once', async () => {
    const application: TestingModule = await startService(
      database,
      nats,
      { ...isolatedNames('crash'), service: 'search-service' },
      { relay: false },
    );
    const relay: OutboxRelay = application.get(OutboxRelay);
    const received: string[] = [];
    // The crash: the statement that marks the row sent fails, after the event reached NATS.
    await database.admin.query(`
      create function simulate_crash() returns trigger language plpgsql as $$
      begin
        if new.status = 'sent' then raise exception 'simulated crash'; end if;
        return new;
      end $$;
      create trigger outbox_crash before update on outbox_events
        for each row execute function simulate_crash();
    `);
    const appended: AppendedEvent = await appendTaskUpdated(application);

    await expect(relay.publishPending()).rejects.toThrow(/simulated crash/u);
    const afterCrash: OutboxRow[] = await outbox();
    const publishedOnce: number = await stored('EVENTS_crash');
    await database.admin.query(
      'drop trigger outbox_crash on outbox_events; drop function simulate_crash()',
    );
    const second: RelayPass = await relay.publishPending();
    const afterRetry: OutboxRow[] = await outbox();
    const publishedTwice: number = await stored('EVENTS_crash');
    // Past the two-minute window the server would store the second copy: the spec stores it.
    const original: StoredMsg | null = await manager.streams.getMessage('EVENTS_crash', { seq: 1 });
    await jetstream(client).publish('evt-crash.task.updated.v1', original?.data);
    await application.get(EventConsumers).subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: (payload: TaskUpdatedV1): Promise<void> => {
        received.push(payload.id);
        return Promise.resolve();
      },
    });
    await waitFor(async () => {
      const consumer: ConsumerInfo = await manager.consumers.info(
        'EVENTS_crash',
        'search-service__index-task',
      );
      return consumer.delivered.stream_seq === 2 && consumer.num_ack_pending === 0;
    });
    const processed: { rows: unknown[] } = await database.admin.query(
      'select consumer, event_id from processed_events',
    );
    await application.close();

    expect(afterCrash).toMatchObject([{ id: appended.id, status: 'pending', attempts: 0 }]);
    expect(publishedOnce).toBe(1);
    expect(second).toEqual({ published: 1, failed: 0, interrupted: false });
    expect(afterRetry).toMatchObject([{ id: appended.id, status: 'sent', attempts: 1 }]);
    expect(publishedTwice).toBe(1);
    expect(await stored('EVENTS_crash')).toBe(2);
    expect(received).toEqual([appended.id]);
    expect(processed.rows).toEqual([
      { consumer: 'search-service__index-task', event_id: appended.id },
    ]);
  });

  it('leaves a refused event pending with its attempt and error class, and still publishes the others', async () => {
    const application: TestingModule = await startService(
      database,
      nats,
      isolatedNames('refused'),
      { relay: false },
    );
    const relay: OutboxRelay = application.get(OutboxRelay);
    // The server refuses the first event only: it is larger than the stream accepts.
    await manager.streams.update('EVENTS_refused', { max_msg_size: 2048 });
    const large: AppendedEvent = await appendTaskUpdated(application, {
      changed: Array.from(
        { length: 400 },
        (_value: unknown, index: number) => `field-${String(index)}`,
      ),
    });
    const small: AppendedEvent = await appendTaskUpdated(application, { taskId: 'CAD-SMALL' });

    const first: RelayPass = await relay.publishPending();
    const afterFirst: OutboxRow[] = await outbox();
    const fresh: AppendedEvent = await appendTaskUpdated(application, { taskId: 'CAD-FRESH' });
    const second: RelayPass = await relay.publishPending();
    const afterSecond: OutboxRow[] = await outbox();
    await application.close();

    expect(first).toEqual({ published: 1, failed: 1, interrupted: false });
    expect(afterFirst).toMatchObject([
      { id: large.id, status: 'pending', attempts: 1, sent_at: null },
      { id: small.id, status: 'sent', attempts: 1, last_error: null },
    ]);
    expect(afterFirst[0]?.last_error).toMatch(/^[A-Za-z]+Error$/u);
    expect(second).toEqual({ published: 1, failed: 1, interrupted: false });
    expect(afterSecond).toMatchObject([
      { id: large.id, status: 'pending', attempts: 2 },
      { id: small.id, status: 'sent' },
      { id: fresh.id, status: 'sent', attempts: 1 },
    ]);
    expect(await stored('EVENTS_refused')).toBe(2);
  });

  it('stops its pass when the stream cannot be reached, then publishes everything once it is back', async () => {
    const application: TestingModule = await startService(database, nats, isolatedNames('down'), {
      relay: false,
    });
    const relay: OutboxRelay = application.get(OutboxRelay);
    // The broker lost the stream after the service started.
    await manager.streams.delete('EVENTS_down');
    await appendTaskUpdated(application, { taskId: 'CAD-1' });
    await appendTaskUpdated(application, { taskId: 'CAD-2' });
    await appendTaskUpdated(application, { taskId: 'CAD-3' });

    const down: RelayPass = await relay.publishPending();
    const whileDown: OutboxRow[] = await outbox();
    await manager.streams.add({ name: 'EVENTS_down', subjects: ['evt-down.>'] });
    const back: RelayPass = await relay.publishPending();
    await application.close();

    expect(down).toEqual({ published: 0, failed: 1, interrupted: true });
    expect(whileDown.map((row: OutboxRow) => row.status)).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
    expect(whileDown.map((row: OutboxRow) => row.attempts)).toEqual([1, 0, 0]);
    expect(whileDown[0]?.last_error).toBe('EventStreamUnavailableError');
    expect(back).toEqual({ published: 3, failed: 0, interrupted: false });
    expect(await allSent(3)).toBe(true);
    expect(await stored('EVENTS_down')).toBe(3);
  });

  it('keeps retrying by itself while the stream is away', async () => {
    const application: TestingModule = await startService(database, nats, isolatedNames('away'));
    await manager.streams.delete('EVENTS_away');
    await appendTaskUpdated(application);

    await waitFor(async () => ((await outbox())[0]?.attempts ?? 0) >= 2);
    await manager.streams.add({ name: 'EVENTS_away', subjects: ['evt-away.>'] });
    await waitFor(() => allSent(1));
    await application.close();

    expect(await stored('EVENTS_away')).toBe(1);
  });

  it('lets two relays share the outbox without publishing a row twice', async () => {
    const first: TestingModule = await startService(database, nats, isolatedNames('shared'), {
      batchSize: 5,
    });
    const second: TestingModule = await startService(database, nats, isolatedNames('shared'), {
      batchSize: 5,
    });

    await Promise.all(
      Array.from({ length: 40 }, (_value: unknown, index: number) =>
        appendTaskUpdated(index % 2 === 0 ? first : second, { taskId: `CAD-${String(index)}` }),
      ),
    );
    await waitFor(() => allSent(40));
    const rows: OutboxRow[] = await outbox();
    await first.close();
    await second.close();

    expect(rows.every((row: OutboxRow) => row.attempts === 1)).toBe(true);
    expect(await stored('EVENTS_shared')).toBe(40);
  });

  it('publishes at once when woken instead of waiting for the poll interval', async () => {
    const application: TestingModule = await startService(database, nats, isolatedNames('wake'), {
      pollIntervalMs: 60_000,
    });
    await delay(300);
    await appendTaskUpdated(application);
    await delay(300);
    const beforeWake: OutboxRow[] = await outbox();

    application.get(OutboxRelay).wake();
    await waitFor(() => allSent(1), 3000);
    await application.close();

    expect(beforeWake).toMatchObject([{ status: 'pending', attempts: 0 }]);
  });

  it('purges old sent rows and old processed ids, and publishes requeued rows again', async () => {
    const application: TestingModule = await startService(database, nats, isolatedNames('purge'), {
      relay: false,
    });
    const relay: OutboxRelay = application.get(OutboxRelay);
    const system: SystemTransactionRunner = application.get(SystemTransactionRunner);
    const old: AppendedEvent = await appendTaskUpdated(application, { taskId: 'CAD-OLD' });
    const recent: AppendedEvent = await appendTaskUpdated(application, { taskId: 'CAD-RECENT' });
    await relay.publishPending();
    const pending: AppendedEvent = await appendTaskUpdated(application, { taskId: 'CAD-PENDING' });
    await database.admin.query(
      `update outbox_events set sent_at = now() - interval '8 days' where id = $1;`,
      [old.id],
    );
    await database.admin.query(
      `update outbox_events set created_at = now() - interval '30 days' where id = $1`,
      [pending.id],
    );
    await database.admin.query(
      `insert into processed_events (consumer, event_id, processed_at) values
         ('search-service__index-task', $1, now() - interval '15 days'),
         ('search-service__index-task', $2, now() - interval '13 days')`,
      [old.id, recent.id],
    );

    const purged: number = await system.run((tx: TransactionScope) => purgeSentOutboxEvents(tx));
    const purgedIds: number = await system.run((tx: TransactionScope) => purgeProcessedEvents(tx));
    const afterPurge: OutboxRow[] = await outbox();
    const requeued: number = await system.run((tx: TransactionScope) =>
      requeueOutboxEvents(tx, new Date(Date.now() - 60_000)),
    );
    const afterRequeue: OutboxRow[] = await outbox();
    const republished: RelayPass = await relay.publishPending();
    const remaining: { rows: unknown[] } = await database.admin.query(
      'select event_id from processed_events',
    );
    await application.close();

    expect(purged).toBe(1);
    expect(purgedIds).toBe(1);
    expect(remaining.rows).toEqual([{ event_id: recent.id }]);
    expect(afterPurge.map((row: OutboxRow) => [row.id, row.status])).toEqual([
      [pending.id, 'pending'],
      [recent.id, 'sent'],
    ]);
    expect(requeued).toBe(1);
    expect(afterRequeue.find((row: OutboxRow) => row.id === recent.id)).toMatchObject({
      status: 'pending',
      sent_at: null,
    });
    expect(republished).toEqual({ published: 2, failed: 0, interrupted: false });
    expect(await allSent(2)).toBe(true);
  });

  it('purges by itself while the relay runs', async () => {
    await database.admin.query(
      `insert into outbox_events (id, event_name, organization_id, payload, status, sent_at)
       values (uuidv7(), 'task.updated.v1', $1, '{}'::jsonb, 'sent', now() - interval '8 days'),
              (uuidv7(), 'task.updated.v1', $1, '{}'::jsonb, 'sent', now() - interval '6 days')`,
      [ATELIER_NORD],
    );
    const application: TestingModule = await startService(
      database,
      nats,
      isolatedNames('autopurge'),
      { purgeIntervalMs: 100 },
    );

    await waitFor(async () => (await outbox()).length === 1);
    await application.close();

    expect((await outbox())[0]?.sent_at?.getTime()).toBeGreaterThan(Date.now() - 7 * 86_400_000);
  });
});
