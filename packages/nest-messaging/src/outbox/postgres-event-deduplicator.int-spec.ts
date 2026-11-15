import { getOrganizationContext } from '@cadenway/nest-common';
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

import { EVENT_DEDUPLICATOR } from '../consumer/event-deduplicator.js';
import { EventConsumers, type EventContext } from '../consumer/event-consumers.js';
import { isolatedNames } from '../testing/application.js';
import {
  ATELIER_NORD,
  CAMILLE,
  eventSchemas,
  userSignedUp,
  type TaskUpdatedV1,
  type UserSignedUpV1,
} from '../testing/events.js';
import { startTestNats, type TestNats } from '../testing/nats.js';
import { appendTaskUpdated, migrateOutbox, startService } from '../testing/outbox.js';
import { startTestDatabase, type TestDatabase } from '../testing/postgres.js';
import { waitFor } from '../testing/wait.js';
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
    const application: TestingModule = await startService(database, nats, {
      ...isolatedNames('rollback'),
      service: 'search-service',
      retryDelaysMs: [100, 100, 100, 100],
    });
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
});
