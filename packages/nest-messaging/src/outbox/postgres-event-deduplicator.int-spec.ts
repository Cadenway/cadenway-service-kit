import { getOrganizationContext, runWithOrganizationContext } from '@cadenway/nest-common';
import {
  SystemTransactionRunner,
  TenantTransactionRunner,
  type TransactionScope,
} from '@cadenway/nest-common/database';
import {
  jetstream,
  jetstreamManager,
  type ConsumerInfo,
  type JetStreamManager,
  type StoredMsg,
} from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  EVENT_DEDUPLICATOR,
  type DeduplicationOutcome,
  type EventDelivery,
  type VersionClaim,
} from '../consumer/event-deduplicator.js';
import { EventConsumers, type EventContext } from '../consumer/event-consumers.js';
import { isolatedNames } from '../testing/application.js';
import {
  ATELIER_NORD,
  CAMILLE,
  eventSchemas,
  OTHER_ORGANIZATION,
  userSignedUp,
  type TaskUpdatedV1,
  type UserSignedUpV1,
} from '../testing/events.js';
import { startTestNats, type TestNats } from '../testing/nats.js';
import { appendTaskUpdated, asMember, migrateOutbox, startService } from '../testing/outbox.js';
import { startTestDatabase, type TestDatabase } from '../testing/postgres.js';
import { delay, waitFor } from '../testing/wait.js';
import { OutboxWriter, type AppendedEvent } from './outbox-writer.js';
import { PostgresEventDeduplicator } from './postgres-event-deduplicator.js';

describe('PostgreSQL deduplicator on real PostgreSQL and NATS', () => {
  let database: TestDatabase;
  let nats: TestNats;
  let client: NatsConnection;
  let manager: JetStreamManager;

  /**
   * Function settled
   *
   * @description
   * Tells whether a consumer was delivered a stream sequence and has nothing left to
   * acknowledge.
   *
   * @param {string} stream - Name of the stream.
   * @param {string} consumer - Name of the durable consumer.
   * @param {number} sequence - Stream sequence expected to be delivered.
   * @returns {Promise<boolean>} `true` once delivered and acknowledged.
   */
  async function settled(stream: string, consumer: string, sequence: number): Promise<boolean> {
    const info: ConsumerInfo = await manager.consumers.info(stream, consumer);
    return info.delivered.stream_seq >= sequence && info.num_ack_pending === 0;
  }

  /**
   * Function table
   *
   * @description
   * Reads a whole table as the superuser.
   *
   * @param {string} statement - Select statement.
   * @returns {Promise<unknown[]>} The rows.
   */
  async function table(statement: string): Promise<unknown[]> {
    const result: { rows: unknown[] } = await database.admin.query(statement);
    return result.rows;
  }

  beforeAll(async () => {
    [database, nats] = await Promise.all([startTestDatabase(), startTestNats()]);
    await migrateOutbox(database, [
      `create table search_index (
         task_id text primary key,
         version integer not null,
         writes integer not null default 1
       )`,
    ]);
    client = await nats.connect();
    manager = await jetstreamManager(client);
  });

  beforeEach(async () => {
    await database.admin.query(
      'truncate outbox_events, processed_events, event_versions, search_index',
    );
  });

  afterAll(async () => {
    await client.close();
    await Promise.all([database.stop(), nats.stop()]);
  });

  it('is the deduplicator of an application that imports the outbox module, and handles an event stored twice once', async () => {
    const application: TestingModule = await startService(database, nats, {
      ...isolatedNames('twice'),
      service: 'search-service',
    });
    const calls: string[] = [];
    await application.get(EventConsumers).subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: (payload: TaskUpdatedV1): Promise<void> => {
        calls.push(payload.id);
        return Promise.resolve();
      },
    });

    const appended: AppendedEvent = await appendTaskUpdated(application);
    await waitFor(() => settled('EVENTS_twice', 'search-service__index-task', 1));
    const original: StoredMsg | null = await manager.streams.getMessage('EVENTS_twice', { seq: 1 });
    await jetstream(client).publish('evt-twice.task.updated.v1', original?.data);
    await waitFor(() => settled('EVENTS_twice', 'search-service__index-task', 2));
    const processed: unknown[] = await table('select consumer, event_id from processed_events');
    const deduplicator: unknown = application.get(EVENT_DEDUPLICATOR);
    await application.close();

    expect(deduplicator).toBeInstanceOf(PostgresEventDeduplicator);
    expect(calls).toEqual([appended.id]);
    expect(processed).toEqual([{ consumer: 'search-service__index-task', event_id: appended.id }]);
  });

  it('rolls back the processed id and the writes of a handler that fails, then handles the redelivery', async () => {
    const application: TestingModule = await startService(
      database,
      nats,
      { ...isolatedNames('rollback'), service: 'search-service' },
      {},
      { retryDelaysMs: [100, 100, 100, 100] },
    );
    const tenant: TenantTransactionRunner = application.get(TenantTransactionRunner);
    const attempts: { deliveryCount: number; settings: unknown }[] = [];
    await application.get(EventConsumers).subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: async (payload: TaskUpdatedV1, eventContext: EventContext): Promise<void> => {
        // A `run` of the tenant runner inside the handler joins the transaction of the delivery.
        const settings: { rows: unknown[] } = await tenant.run(async (tx: TransactionScope) => {
          await tx.client.query('insert into search_index (task_id, version) values ($1, $2)', [
            payload.taskId,
            payload.version,
          ]);
          return tx.client.query(
            `select current_setting('app.organization_id', true) as organization,
                    current_setting('app.system_access', true) as system`,
          );
        });
        attempts.push({ deliveryCount: eventContext.deliveryCount, settings: settings.rows[0] });
        if (eventContext.deliveryCount === 1) {
          throw new Error('index unavailable');
        }
      },
    });

    const appended: AppendedEvent = await appendTaskUpdated(application, { version: 2 });
    await waitFor(() => attempts.length === 1);
    const afterFailure: unknown[][] = [
      await table('select task_id from search_index'),
      await table('select event_id from processed_events'),
    ];
    await waitFor(() => attempts.length === 2);
    await waitFor(() => settled('EVENTS_rollback', 'search-service__index-task', 1));
    const index: unknown[] = await table('select task_id, version, writes from search_index');
    const processed: unknown[] = await table('select event_id from processed_events');
    await application.close();

    expect(afterFailure).toEqual([[], []]);
    expect(attempts).toEqual([
      { deliveryCount: 1, settings: { organization: ATELIER_NORD, system: 'off' } },
      { deliveryCount: 2, settings: { organization: ATELIER_NORD, system: 'off' } },
    ]);
    expect(index).toEqual([{ task_id: 'CAD-482', version: 2, writes: 1 }]);
    expect(processed).toEqual([{ event_id: appended.id }]);
  });

  it('skips an event whose version is not newer than the one already applied', async () => {
    const application: TestingModule = await startService(database, nats, {
      ...isolatedNames('versions'),
      service: 'search-service',
    });
    const tenant: TenantTransactionRunner = application.get(TenantTransactionRunner);
    const seen: number[] = [];
    await application.get(EventConsumers).subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: async (payload: TaskUpdatedV1, eventContext: EventContext): Promise<void> => {
        seen.push(payload.version);
        if (!(await eventContext.claimVersion(`task:${payload.taskId}`))) {
          return;
        }
        await tenant.run((tx: TransactionScope) =>
          tx.client.query(
            `insert into search_index (task_id, version) values ($1, $2)
             on conflict (task_id) do update
               set version = excluded.version, writes = search_index.writes + 1`,
            [payload.taskId, payload.version],
          ),
        );
      },
    });

    // Version 5 arrives first, then a late version 3, version 5 again under a new id, then 6.
    for (const [sequence, version] of [5, 3, 5, 6].entries()) {
      await appendTaskUpdated(application, { version });
      await waitFor(() => settled('EVENTS_versions', 'search-service__index-task', sequence + 1));
    }
    await appendTaskUpdated(application, { version: 1, taskId: 'CAD-483' });
    await waitFor(() => settled('EVENTS_versions', 'search-service__index-task', 5));
    const index: unknown[] = await table(
      'select task_id, version, writes from search_index order by task_id',
    );
    const versions: unknown[] = await table(
      'select consumer, aggregate_key, version from event_versions order by aggregate_key',
    );
    const processed: unknown[] = await table('select event_id from processed_events');
    await application.close();

    expect(seen).toEqual([5, 3, 5, 6, 1]);
    expect(index).toEqual([
      { task_id: 'CAD-482', version: 6, writes: 2 },
      { task_id: 'CAD-483', version: 1, writes: 1 },
    ]);
    expect(versions).toEqual([
      { consumer: 'search-service__index-task', aggregate_key: 'task:CAD-482', version: '6' },
      { consumer: 'search-service__index-task', aggregate_key: 'task:CAD-483', version: '1' },
    ]);
    expect(processed).toHaveLength(5);
  });

  it('takes an event without an organization through the system runner, from the outbox to the handler', async () => {
    const application: TestingModule = await startService(database, nats, {
      ...isolatedNames('system'),
      service: 'notification-service',
    });
    const system: SystemTransactionRunner = application.get(SystemTransactionRunner);
    const tenant: TenantTransactionRunner = application.get(TenantTransactionRunner);
    const seen: { userId: string; organizationId: unknown; settings: unknown; tenant: string }[] =
      [];
    await application.get(EventConsumers).subscribe({
      handler: 'welcome',
      schemas: eventSchemas,
      event: 'user.signed-up.v1',
      handle: async (payload: UserSignedUpV1): Promise<void> => {
        // Joining with the system runner proves the delivery runs in a system transaction.
        const settings: { rows: unknown[] } = await system.run((tx: TransactionScope) =>
          tx.client.query(
            `select current_setting('app.organization_id', true) as organization,
                    current_setting('app.system_access', true) as system`,
          ),
        );
        const refused: string = await tenant
          .run(() => Promise.resolve('joined'))
          .catch((error: unknown) => (error instanceof Error ? error.message : 'unknown'));
        seen.push({
          userId: payload.userId,
          organizationId: getOrganizationContext()?.organizationId,
          settings: settings.rows[0],
          tenant: refused,
        });
      },
    });

    const appended: AppendedEvent = await system.run((tx: TransactionScope) =>
      application.get(OutboxWriter).append(tx, eventSchemas, 'user.signed-up.v1', userSignedUp()),
    );
    await waitFor(() => settled('EVENTS_system', 'notification-service__welcome', 1));
    const outbox: unknown[] = await table('select id, organization_id, status from outbox_events');
    const processed: unknown[] = await table('select consumer, event_id from processed_events');
    await application.close();

    expect(outbox).toEqual([{ id: appended.id, organization_id: null, status: 'sent' }]);
    expect(seen).toEqual([
      {
        userId: CAMILLE,
        organizationId: null,
        settings: { organization: '', system: 'on' },
        tenant: 'No organization in the current context.',
      },
    ]);
    expect(processed).toEqual([
      { consumer: 'notification-service__welcome', event_id: appended.id },
    ]);
  });

  it('keeps the versions of two organizations apart for the same aggregate key', async () => {
    const application: TestingModule = await startService(database, nats, {
      ...isolatedNames('orgversions'),
      service: 'search-service',
    });
    const claims: { organizationId: string; version: number; apply: boolean }[] = [];
    await application.get(EventConsumers).subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: async (payload: TaskUpdatedV1, eventContext: EventContext): Promise<void> => {
        claims.push({
          organizationId: payload.organizationId,
          version: payload.version,
          apply: await eventContext.claimVersion(`task:${payload.taskId}`),
        });
      },
    });

    // The same task key in two organizations: version 7 of one must not make version 3 of the
    // other stale.
    await appendTaskUpdated(application, { version: 7 });
    await waitFor(() => claims.length === 1);
    await appendTaskUpdated(application, { organizationId: OTHER_ORGANIZATION, version: 3 });
    await waitFor(() => claims.length === 2);
    await appendTaskUpdated(application, { organizationId: OTHER_ORGANIZATION, version: 2 });
    await waitFor(() => claims.length === 3);
    const versions: unknown[] = await table(
      'select organization_id, aggregate_key, version from event_versions order by version desc',
    );
    await application.close();

    expect(claims).toEqual([
      { organizationId: ATELIER_NORD, version: 7, apply: true },
      { organizationId: OTHER_ORGANIZATION, version: 3, apply: true },
      { organizationId: OTHER_ORGANIZATION, version: 2, apply: false },
    ]);
    expect(versions).toEqual([
      { organization_id: ATELIER_NORD, aggregate_key: 'task:CAD-482', version: '7' },
      { organization_id: OTHER_ORGANIZATION, aggregate_key: 'task:CAD-482', version: '3' },
    ]);
  });

  it('compares the versions of events without an organization with each other', async () => {
    const application: TestingModule = await startService(database, nats, {
      ...isolatedNames('nullversions'),
      service: 'notification-service',
    });
    const deduplicator: PostgresEventDeduplicator = application.get(PostgresEventDeduplicator);
    const claimed: boolean[] = [];

    for (const [id, version] of [
      ['0193a1f0-0000-7000-8000-0000000000f1', 4],
      ['0193a1f0-0000-7000-8000-0000000000f2', 2],
    ] as const) {
      await runWithOrganizationContext(
        { organizationId: null, actor: { type: 'system', id: null }, role: null, scopes: [] },
        () =>
          deduplicator.run(
            {
              consumer: 'notification-service__welcome',
              event: 'user.signed-up.v1',
              envelope: {
                id,
                occurredAt: '2026-11-14T09:30:00.000Z',
                organizationId: null,
                actor: { type: 'system', id: 'identity-service' },
                version,
              },
            },
            async (claimVersion: VersionClaim): Promise<void> => {
              claimed.push(await claimVersion(`user:${CAMILLE}`));
            },
          ),
      );
    }
    const versions: unknown[] = await table(
      'select organization_id, version from event_versions where aggregate_key like $$user:%$$',
    );
    await application.close();

    expect(claimed).toEqual([true, false]);
    expect(versions).toEqual([{ organization_id: null, version: '4' }]);
  });

  it('bounds the wait of a delivery for the processed id another delivery of the same event holds', async () => {
    const application: TestingModule = await startService(
      database,
      nats,
      { ...isolatedNames('locked'), service: 'search-service' },
      {},
      { claimLockTimeoutMs: 300 },
    );
    const deduplicator: PostgresEventDeduplicator = application.get(PostgresEventDeduplicator);
    const delivery: EventDelivery = {
      consumer: 'search-service__index-task',
      event: 'task.updated.v1',
      envelope: {
        id: '0193a1f0-0000-7000-8000-0000000000f3',
        occurredAt: '2026-11-14T09:30:00.000Z',
        organizationId: ATELIER_NORD,
        actor: { type: 'user', id: CAMILLE },
        version: 1,
      },
    };
    let release: () => void = (): void => undefined;
    const gate: Promise<void> = new Promise<void>((resolve: () => void) => {
      release = resolve;
    });

    const first: Promise<DeduplicationOutcome> = asMember(ATELIER_NORD, () =>
      deduplicator.run(delivery, () => gate),
    );
    await delay(200);
    const started: number = Date.now();
    const second: Promise<DeduplicationOutcome> = asMember(ATELIER_NORD, () =>
      deduplicator.run(delivery, () => Promise.resolve()),
    );
    await expect(second).rejects.toThrow(/lock timeout/u);
    const waited: number = Date.now() - started;
    release();
    const outcome: DeduplicationOutcome = await first;
    const third: DeduplicationOutcome = await asMember(ATELIER_NORD, () =>
      deduplicator.run(delivery, () => Promise.resolve()),
    );
    await application.close();

    expect(waited).toBeLessThan(2000);
    expect(outcome).toBe('handled');
    expect(third).toBe('duplicate');
  });

  it('abandons a handler at its deadline, rolls its writes back, and handles the next message meanwhile', async () => {
    const application: TestingModule = await startService(
      database,
      nats,
      { ...isolatedNames('hung'), service: 'search-service', handlerTimeoutMs: 500 },
      {},
      { retryDelaysMs: [300, 300, 300, 300] },
    );
    const tenant: TenantTransactionRunner = application.get(TenantTransactionRunner);
    const handled: string[] = [];
    let aborted: boolean = false;
    await application.get(EventConsumers).subscribe({
      handler: 'index-task',
      schemas: eventSchemas,
      event: 'task.updated.v1',
      handle: async (payload: TaskUpdatedV1, eventContext: EventContext): Promise<void> => {
        await tenant.run((tx: TransactionScope) =>
          tx.client.query('insert into search_index (task_id, version) values ($1, $2)', [
            payload.taskId,
            payload.version,
          ]),
        );
        if (payload.taskId === 'CAD-HUNG' && eventContext.deliveryCount === 1) {
          eventContext.signal.addEventListener('abort', () => {
            aborted = true;
          });
          await new Promise<never>(() => undefined);
        }
        handled.push(`${payload.taskId}#${String(eventContext.deliveryCount)}`);
      },
    });

    await appendTaskUpdated(application, { taskId: 'CAD-HUNG' });
    await appendTaskUpdated(application, { taskId: 'CAD-NEXT' });
    await waitFor(() => handled.length === 2, 10_000);
    const index: unknown[] = await table(
      'select task_id, writes from search_index order by task_id',
    );
    const processed: unknown[] = await table('select event_id from processed_events');
    await application.close();

    expect(aborted).toBe(true);
    expect(handled).toEqual(['CAD-NEXT#1', 'CAD-HUNG#2']);
    expect(index).toEqual([
      { task_id: 'CAD-HUNG', writes: 1 },
      { task_id: 'CAD-NEXT', writes: 1 },
    ]);
    expect(processed).toHaveLength(2);
  });
});
