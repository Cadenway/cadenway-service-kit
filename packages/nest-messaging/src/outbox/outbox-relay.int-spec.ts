import {
  DatabaseModule,
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
import { Module } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { context, ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { EventConsumers } from '../consumer/event-consumers.js';
import { MessagingModule } from '../messaging.module.js';
import { EVENT_NAME_HEADER, TRACEPARENT_HEADER } from '../publisher/event-headers.js';
import {
  disableTracePropagation,
  enableTracePropagation,
  isolatedNames,
  messagingOptions,
  startApplication,
} from '../testing/application.js';
import {
  ATELIER_NORD,
  CAMILLE,
  eventSchemas,
  taskUpdated,
  userSignedUp,
  type TaskUpdatedV1,
  type UserSignedUpV1,
} from '../testing/events.js';
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
import { OutboxModule } from './outbox.module.js';

/**
 * Constant SETTINGS
 *
 * @description
 * Injection token of the settings of the spec, provided by a module that is not global.
 *
 * @type {symbol}
 */
const SETTINGS: unique symbol = Symbol('settings');

/**
 * Interface Settings
 *
 * @description
 * Settings the asynchronous options are built from.
 */
interface Settings {
  // #region Properties
  /**
   * Property service
   *
   * @description
   * Name of the service.
   *
   * @type {string}
   * @readonly
   */
  readonly service: string;

  /**
   * Property relay
   *
   * @description
   * Whether the relay runs.
   *
   * @type {boolean}
   * @readonly
   */
  readonly relay: boolean;
  // #endregion
}

/**
 * Class SettingsModule
 *
 * @description
 * Non-global module providing the settings, as a configuration module of an application would.
 */
@Module({
  providers: [{ provide: SETTINGS, useValue: { service: 'task-service', relay: false } }],
  exports: [SETTINGS],
})
class SettingsModule {}

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

/**
 * Interface StoredPayload
 *
 * @description
 * Status and payload of an outbox row, for the specs of the redaction.
 */
interface StoredPayload {
  // #region Properties
  /**
   * Property status
   *
   * @description
   * `pending`, `sent` or `failed`.
   *
   * @type {string}
   * @readonly
   */
  readonly status: string;

  /**
   * Property attempts
   *
   * @description
   * Number of failed publish attempts.
   *
   * @type {number}
   * @readonly
   */
  readonly attempts: number;

  /**
   * Property payload
   *
   * @description
   * Payload as the table holds it.
   *
   * @type {Record<string, unknown>}
   * @readonly
   */
  readonly payload: Record<string, unknown>;
  // #endregion
}

/**
 * Function appendUserSignedUp
 *
 * @description
 * Runs a use case without organization that appends one `user.signed-up.v1` event to the outbox
 * and commits, in a system transaction. The specs list it as a restricted event: it stands for
 * the identity events that carry a single-use code.
 *
 * @param {TestingModule} application - Application started with `startService`.
 * @returns {Promise<AppendedEvent>} The id and the instant of the event.
 */
function appendUserSignedUp(application: TestingModule): Promise<AppendedEvent> {
  return application
    .get(SystemTransactionRunner)
    .run((tx: TransactionScope<DatabaseSchema>) =>
      application.get(OutboxWriter).append(tx, eventSchemas, 'user.signed-up.v1', userSignedUp()),
    );
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

  /**
   * Function payloads
   *
   * @description
   * Reads the status, attempts and payload of every outbox row as the superuser, by event id.
   *
   * @returns {Promise<Map<string, StoredPayload>>} The rows, by id.
   */
  async function payloads(): Promise<Map<string, StoredPayload>> {
    const result: { rows: (StoredPayload & { id: string })[] } = await database.admin.query(
      'select id, status, attempts, payload from outbox_events',
    );
    return new Map<string, StoredPayload>(
      result.rows.map(({ id, ...row }: StoredPayload & { id: string }) => [id, row]),
    );
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
    expect(rows[0]).toMatchObject({ id: committed.id, status: 'sent', attempts: 0 });
    expect(rows[0]?.sent_at).toBeInstanceOf(Date);
  });

  it('keeps a restricted event restricted during a rolling deploy: the relay publishes the route the writer stored', async () => {
    const names: ReturnType<typeof isolatedNames> = isolatedNames('rolling');
    // The new replica knows the event is restricted; the old one, which relays, does not.
    const writer: TestingModule = await startService(
      database,
      nats,
      { ...names, restrictedEvents: ['task.updated.v1'] },
      { relay: false },
    );
    const relay: TestingModule = await startService(database, nats, names, { relay: false });

    const appended: AppendedEvent = await appendTaskUpdated(writer);
    const row: { rows: unknown[] } = await database.admin.query(
      'select subject, stream from outbox_events where id = $1',
      [appended.id],
    );
    const pass: RelayPass = await relay.get(OutboxRelay).publishPending();
    const restricted: StoredMsg | null = await manager.streams.getMessage(
      'EVENTS_RESTRICTED_rolling',
      { last_by_subj: 'restricted-rolling.task.updated.v1' },
    );
    const relayed: StoredPayload | undefined = (await payloads()).get(appended.id);
    await writer.close();
    await relay.close();

    expect(row.rows[0]).toEqual({
      subject: 'restricted-rolling.task.updated.v1',
      stream: 'EVENTS_RESTRICTED_rolling',
    });
    expect(pass).toEqual({ published: 1, failed: 0, interrupted: false });
    expect(restricted?.json<TaskUpdatedV1>()).toMatchObject({ id: appended.id, taskId: 'CAD-482' });
    expect(await stored('EVENTS_rolling')).toBe(0);
    // The old replica redacts the row too: it reads the route stored with it.
    expect(relayed?.payload).not.toHaveProperty('taskId');
    expect(relayed?.payload).toHaveProperty('$redacted', true);
  });

  it('redacts a restricted row in the statement that marks it sent, keeps its payload until its publish succeeds, and leaves an unrestricted row as it is', async () => {
    const application: TestingModule = await startService(
      database,
      nats,
      {
        ...isolatedNames('redact'),
        service: 'identity-service',
        restrictedEvents: ['user.signed-up.v1'],
      },
      { relay: false },
    );
    const relay: OutboxRelay = application.get(OutboxRelay);
    const restricted: AppendedEvent = await appendUserSignedUp(application);
    const unrestricted: AppendedEvent = await appendTaskUpdated(application, {
      taskId: 'CAD-PLAIN',
    });
    const written: Map<string, StoredPayload> = await payloads();
    // The server refuses the restricted message once: the relay must be able to try it again.
    await manager.streams.update('EVENTS_RESTRICTED_redact', { max_msg_size: 64 });

    const first: RelayPass = await relay.publishPending();
    const afterFailure: Map<string, StoredPayload> = await payloads();
    await manager.streams.update('EVENTS_RESTRICTED_redact', { max_msg_size: -1 });
    await database.admin.query('update outbox_events set next_attempt_at = now() where id = $1', [
      restricted.id,
    ]);
    const second: RelayPass = await relay.publishPending();
    const afterPublish: Map<string, StoredPayload> = await payloads();
    const message: StoredMsg | null = await manager.streams.getMessage('EVENTS_RESTRICTED_redact', {
      last_by_subj: 'restricted-redact.user.signed-up.v1',
    });
    await application.close();

    expect(written.get(restricted.id)?.payload).toMatchObject({
      id: restricted.id,
      email: 'camille@example.test',
    });
    expect(first).toEqual({ published: 1, failed: 1, interrupted: false });
    expect(afterFailure.get(restricted.id)).toEqual({
      status: 'pending',
      attempts: 1,
      payload: written.get(restricted.id)?.payload,
    });
    expect(second).toEqual({ published: 1, failed: 0, interrupted: false });
    // The message delivered on restricted.<name> carries the whole payload.
    expect(message?.json<UserSignedUpV1>()).toEqual(written.get(restricted.id)?.payload);
    // The row keeps the envelope and the marker only.
    expect(afterPublish.get(restricted.id)).toEqual({
      status: 'sent',
      attempts: 1,
      payload: {
        id: restricted.id,
        occurredAt: restricted.occurredAt,
        organizationId: null,
        actor: { type: 'user', id: CAMILLE },
        version: 1,
        $redacted: true,
      },
    });
    expect(afterPublish.get(unrestricted.id)).toEqual({
      status: 'sent',
      attempts: 0,
      payload: written.get(unrestricted.id)?.payload,
    });
    expect(written.get(unrestricted.id)?.payload).toMatchObject({ taskId: 'CAD-PLAIN' });
  });

  it('never requeues nor publishes again a redacted row, and still requeues an unrestricted one', async () => {
    const application: TestingModule = await startService(
      database,
      nats,
      {
        ...isolatedNames('noreplay'),
        service: 'identity-service',
        restrictedEvents: ['user.signed-up.v1'],
      },
      { relay: false },
    );
    const relay: OutboxRelay = application.get(OutboxRelay);
    const system: SystemTransactionRunner = application.get(SystemTransactionRunner);
    const restricted: AppendedEvent = await appendUserSignedUp(application);
    const unrestricted: AppendedEvent = await appendTaskUpdated(application);
    const sent: RelayPass = await relay.publishPending();

    const requeued: number = await system.run((tx: TransactionScope) =>
      requeueOutboxEvents(tx, new Date(Date.now() - 60_000)),
    );
    const afterRequeue: Map<string, StoredPayload> = await payloads();
    const republished: RelayPass = await relay.publishPending();
    // An operator, or the requeue of an older kit, makes the redacted row pending again.
    await database.admin.query(
      `update outbox_events set status = 'pending', sent_at = null where id = $1`,
      [restricted.id],
    );
    const guarded: RelayPass = await relay.publishPending();
    const afterGuard: Map<string, StoredPayload> = await payloads();
    await application.close();

    expect(sent).toEqual({ published: 2, failed: 0, interrupted: false });
    expect(requeued).toBe(1);
    expect(afterRequeue.get(restricted.id)?.status).toBe('sent');
    expect(afterRequeue.get(unrestricted.id)?.status).toBe('pending');
    expect(republished).toEqual({ published: 1, failed: 0, interrupted: false });
    expect(guarded).toEqual({ published: 0, failed: 0, interrupted: false });
    expect(afterGuard.get(restricted.id)?.status).toBe('sent');
    expect(afterGuard.get(restricted.id)?.payload).toHaveProperty('$redacted', true);
    expect(afterGuard.get(restricted.id)?.payload).not.toHaveProperty('email');
  });

  it('keeps a restricted row pending and whole after a crash between its publish and the commit, then redacts it once it is marked sent', async () => {
    const application: TestingModule = await startService(
      database,
      nats,
      {
        ...isolatedNames('redactcrash'),
        service: 'identity-service',
        restrictedEvents: ['user.signed-up.v1'],
      },
      { relay: false },
    );
    const relay: OutboxRelay = application.get(OutboxRelay);
    await database.admin.query(`
      create function simulate_crash() returns trigger language plpgsql as $$
      begin
        if new.status = 'sent' then raise exception 'simulated crash'; end if;
        return new;
      end $$;
      create trigger outbox_crash before update on outbox_events
        for each row execute function simulate_crash();
    `);
    const restricted: AppendedEvent = await appendUserSignedUp(application);
    const written: Map<string, StoredPayload> = await payloads();

    await expect(relay.publishPending()).rejects.toThrow(/simulated crash/u);
    const afterCrash: Map<string, StoredPayload> = await payloads();
    const publishedOnce: number = await stored('EVENTS_RESTRICTED_redactcrash');
    await database.admin.query(
      'drop trigger outbox_crash on outbox_events; drop function simulate_crash()',
    );
    const second: RelayPass = await relay.publishPending();
    const afterRetry: Map<string, StoredPayload> = await payloads();
    await application.close();

    expect(publishedOnce).toBe(1);
    expect(afterCrash.get(restricted.id)).toEqual({
      status: 'pending',
      attempts: 0,
      payload: written.get(restricted.id)?.payload,
    });
    expect(second).toEqual({ published: 1, failed: 0, interrupted: false });
    // The server dropped the second copy inside its window; the row is now sent and redacted.
    expect(await stored('EVENTS_RESTRICTED_redactcrash')).toBe(1);
    expect(afterRetry.get(restricted.id)?.status).toBe('sent');
    expect(afterRetry.get(restricted.id)?.payload).toHaveProperty('$redacted', true);
    expect(afterRetry.get(restricted.id)?.payload).not.toHaveProperty('email');
  });

  it('redacts by itself the restricted rows an older kit sent whole, and leaves parked and unrestricted rows alone', async () => {
    const signedUp: Record<string, unknown> = {
      id: '0193a1f0-0000-7000-8000-0000000000d1',
      occurredAt: '2026-11-15T10:00:00.000Z',
      ...userSignedUp(),
    };
    const parked: Record<string, unknown> = {
      ...signedUp,
      id: '0193a1f0-0000-7000-8000-0000000000d2',
    };
    const task: Record<string, unknown> = {
      id: '0193a1f0-0000-7000-8000-0000000000d3',
      occurredAt: '2026-11-15T10:00:00.000Z',
      ...taskUpdated({ taskId: 'CAD-OLD-KIT' }),
    };
    // What an older kit leaves behind: a restricted row sent with its payload.
    await database.admin.query(
      `insert into outbox_events
         (id, event_name, subject, stream, organization_id, payload, status, sent_at, attempts)
       values
         ($1, 'user.signed-up.v1', 'restricted-sweep.user.signed-up.v1', 'EVENTS_RESTRICTED_sweep',
          null, $2::jsonb, 'sent', now() - interval '1 hour', 0),
         ($3, 'user.signed-up.v1', 'restricted-sweep.user.signed-up.v1', 'EVENTS_RESTRICTED_sweep',
          null, $4::jsonb, 'failed', null, 20),
         ($5, 'task.updated.v1', 'evt-sweep.task.updated.v1', 'EVENTS_sweep',
          $6, $7::jsonb, 'sent', now() - interval '1 hour', 0)`,
      [
        signedUp.id,
        JSON.stringify(signedUp),
        parked.id,
        JSON.stringify(parked),
        task.id,
        ATELIER_NORD,
        JSON.stringify(task),
      ],
    );

    const application: TestingModule = await startService(database, nats, {
      ...isolatedNames('sweep'),
      service: 'identity-service',
    });
    await waitFor(async () =>
      Object.hasOwn((await payloads()).get(String(signedUp.id))?.payload ?? {}, '$redacted'),
    );
    const rows: Map<string, StoredPayload> = await payloads();
    await application.close();

    expect(rows.get(String(signedUp.id))).toEqual({
      status: 'sent',
      attempts: 0,
      payload: {
        id: signedUp.id,
        occurredAt: signedUp.occurredAt,
        organizationId: null,
        actor: { type: 'user', id: CAMILLE },
        version: 1,
        $redacted: true,
      },
    });
    expect(rows.get(String(parked.id))).toEqual({
      status: 'failed',
      attempts: 20,
      payload: parked,
    });
    expect(rows.get(String(task.id))).toEqual({ status: 'sent', attempts: 0, payload: task });
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
    expect(afterRetry).toMatchObject([{ id: appended.id, status: 'sent', attempts: 0 }]);
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
    const delayed: { rows: unknown[] } = await database.admin.query(
      `select extract(epoch from next_attempt_at - now()) as wait from outbox_events where id = $1`,
      [large.id],
    );
    const fresh: AppendedEvent = await appendTaskUpdated(application, { taskId: 'CAD-FRESH' });
    const second: RelayPass = await relay.publishPending();
    const afterSecond: OutboxRow[] = await outbox();
    await delay(1100);
    const third: RelayPass = await relay.publishPending();
    const backoff: { rows: unknown[] } = await database.admin.query(
      `select attempts, extract(epoch from next_attempt_at - now()) as wait
         from outbox_events where id = $1`,
      [large.id],
    );
    await application.close();

    expect(first).toEqual({ published: 1, failed: 1, interrupted: false });
    expect(afterFirst).toMatchObject([
      { id: large.id, status: 'pending', attempts: 1, sent_at: null },
      { id: small.id, status: 'sent', attempts: 0, last_error: null },
    ]);
    expect(afterFirst[0]?.last_error).toMatch(/^[A-Za-z]+Error$/u);
    // The row that keeps failing waits 1 s, then 2 s: it is not tried at every pass.
    expect(Number((delayed.rows[0] as { wait: string }).wait)).toBeGreaterThan(0.5);
    expect(second).toEqual({ published: 1, failed: 0, interrupted: false });
    expect(afterSecond).toMatchObject([
      { id: large.id, status: 'pending', attempts: 1 },
      { id: small.id, status: 'sent' },
      { id: fresh.id, status: 'sent', attempts: 0 },
    ]);
    expect(third).toEqual({ published: 0, failed: 1, interrupted: false });
    expect(backoff.rows[0]).toMatchObject({ attempts: 2 });
    expect(Number((backoff.rows[0] as { wait: string }).wait)).toBeGreaterThan(1.5);
    expect(await stored('EVENTS_refused')).toBe(2);
  });

  it('parks a row after 20 failed attempts, until requeueOutboxEvents gives it a new series', async () => {
    const application: TestingModule = await startService(database, nats, isolatedNames('parked'), {
      relay: false,
    });
    const relay: OutboxRelay = application.get(OutboxRelay);
    const system: SystemTransactionRunner = application.get(SystemTransactionRunner);
    await manager.streams.update('EVENTS_parked', { max_msg_size: 2048 });
    const large: AppendedEvent = await appendTaskUpdated(application, {
      changed: Array.from(
        { length: 400 },
        (_value: unknown, index: number) => `field-${String(index)}`,
      ),
    });
    await database.admin.query('update outbox_events set attempts = 19 where id = $1', [large.id]);

    const last: RelayPass = await relay.publishPending();
    const parked: OutboxRow[] = await outbox();
    const skipped: RelayPass = await relay.publishPending();
    const requeued: number = await system.run((tx: TransactionScope) =>
      requeueOutboxEvents(tx, new Date()),
    );
    const afterRequeue: OutboxRow[] = await outbox();
    await application.close();

    expect(last).toEqual({ published: 0, failed: 1, interrupted: false });
    expect(parked).toMatchObject([{ id: large.id, status: 'failed', attempts: 20 }]);
    expect(skipped).toEqual({ published: 0, failed: 0, interrupted: false });
    expect(requeued).toBe(1);
    expect(afterRequeue).toMatchObject([
      { id: large.id, status: 'pending', attempts: 0, last_error: null },
    ]);
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

    // A failure that concerns every row stops the pass and does not count against the row.
    expect(down).toEqual({ published: 0, failed: 0, interrupted: true });
    expect(whileDown.map((row: OutboxRow) => row.status)).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
    expect(whileDown.map((row: OutboxRow) => row.attempts)).toEqual([0, 0, 0]);
    expect(whileDown[0]?.last_error).toBe('EventStreamUnavailableError');
    expect(back).toEqual({ published: 3, failed: 0, interrupted: false });
    expect(await allSent(3)).toBe(true);
    expect(await stored('EVENTS_down')).toBe(3);
  });

  it('keeps retrying by itself while the stream is away', async () => {
    const application: TestingModule = await startService(database, nats, isolatedNames('away'));
    await manager.streams.delete('EVENTS_away');
    await appendTaskUpdated(application);

    await waitFor(async () => (await outbox())[0]?.last_error === 'EventStreamUnavailableError');
    await manager.streams.add({ name: 'EVENTS_away', subjects: ['evt-away.>'] });
    await waitFor(() => allSent(1));
    await application.close();

    expect(await stored('EVENTS_away')).toBe(1);
    expect((await outbox())[0]?.attempts).toBe(0);
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

    expect(rows.every((row: OutboxRow) => row.attempts === 0)).toBe(true);
    expect(await stored('EVENTS_shared')).toBe(40);
  });

  it('is configured asynchronously from a module that is not global', async () => {
    const application: TestingModule = await startApplication([
      DatabaseModule.forRoot({ connectionString: database.appUrl, poolSize: 2 }),
      MessagingModule.forRootAsync({
        imports: [SettingsModule],
        inject: [SETTINGS],
        useFactory: (settings: Settings) =>
          messagingOptions(nats, { ...isolatedNames('async'), service: settings.service }),
      }),
      OutboxModule.forRootAsync({
        imports: [SettingsModule],
        inject: [SETTINGS],
        useFactory: (settings: Settings) => ({ relay: settings.relay, pollIntervalMs: 50 }),
      }),
    ]);

    await appendTaskUpdated(application);
    await delay(400);
    const pending: OutboxRow[] = await outbox();
    const pass: RelayPass = await application.get(OutboxRelay).publishPending();
    await application.close();

    expect(pending).toMatchObject([{ status: 'pending' }]);
    expect(pass).toEqual({ published: 1, failed: 0, interrupted: false });
    expect(await stored('EVENTS_async')).toBe(1);
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
      `insert into outbox_events (id, event_name, subject, stream, organization_id, payload, status, sent_at)
       values (uuidv7(), 'task.updated.v1', 'evt.task.updated.v1', 'EVENTS', $1, '{}'::jsonb, 'sent', now() - interval '8 days'),
              (uuidv7(), 'task.updated.v1', 'evt.task.updated.v1', 'EVENTS', $1, '{}'::jsonb, 'sent', now() - interval '6 days')`,
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
