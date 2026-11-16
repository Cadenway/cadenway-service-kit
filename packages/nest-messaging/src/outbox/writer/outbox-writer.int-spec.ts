import { runWithOrganizationContext, type OrganizationContext } from '@cadenway/nest-common';
import {
  SystemTransactionRunner,
  TenantTransactionRunner,
  type TransactionScope,
} from '@cadenway/nest-common/database';
import { context, ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { EventValidationError } from '../../events/event-validation-error.js';
import { resolveMessagingOptions } from '../../configuration/resolve-messaging-options.js';
import { disableTracePropagation, enableTracePropagation } from '../../testing/application.js';
import {
  ATELIER_NORD,
  CAMILLE,
  eventSchemas,
  OTHER_ORGANIZATION,
  taskUpdated,
  userSignedUp,
} from '../../testing/events.js';
import { kitMigration, startTestDatabase, type TestDatabase } from '../../testing/postgres.js';
import eventVersions from '../schema/event-versions.schema.js';
import outboxEvents from '../schema/outbox-events.schema.js';
import { OutboxWriter, type AppendedEvent } from './outbox-writer.js';
import processedEvents from '../schema/processed-events.schema.js';

/**
 * Function as
 *
 * @description
 * Runs work in the organization context of a user of the given organization, as the
 * internal-token interceptor does for a request.
 *
 * @param {string} organizationId - Organization of the verified token.
 * @param {() => Promise<TResult>} work - Work to run.
 * @returns {Promise<TResult>} What the work returns.
 */
function as<TResult>(organizationId: string, work: () => Promise<TResult>): Promise<TResult> {
  const organization: OrganizationContext = {
    organizationId,
    actor: { type: 'user', id: CAMILLE },
    role: 'member',
    scopes: [],
  };
  return runWithOrganizationContext(organization, work);
}

describe('outbox writer on a real PostgreSQL', () => {
  let database: TestDatabase;
  let pool: pg.Pool;
  let tenant: TenantTransactionRunner;
  let system: SystemTransactionRunner;
  let statements: string[];
  const writer: OutboxWriter = new OutboxWriter(
    resolveMessagingOptions({
      service: 'identity-service',
      servers: 'nats://unused:4222',
      restrictedEvents: ['user.signed-up.v1'],
    }),
  );

  /**
   * Function rows
   *
   * @description
   * Reads the outbox as the superuser, whatever the policies say.
   *
   * @returns {Promise<Record<string, unknown>[]>} The rows, oldest first.
   */
  async function rows(): Promise<Record<string, unknown>[]> {
    const result: { rows: Record<string, unknown>[] } = await database.admin.query(
      'select * from outbox_events order by created_at, id',
    );
    return result.rows;
  }

  beforeAll(async () => {
    enableTracePropagation();
    database = await startTestDatabase();
    statements = await kitMigration({ outboxEvents, processedEvents, eventVersions });
    await database.migrate(statements, ['outbox_events', 'event_versions']);
    pool = new pg.Pool({ connectionString: database.appUrl, max: 2 });
    tenant = new TenantTransactionRunner(pool);
    system = new SystemTransactionRunner(pool);
  });

  beforeEach(async () => {
    await database.admin.query('truncate outbox_events');
  });

  afterAll(async () => {
    await pool.end();
    await database.stop();
    disableTracePropagation();
  });

  it('ships three tables whose generated DDL enables row-level security on the outbox', () => {
    const ddl: string = statements.join('\n');

    expect(ddl).toMatch(/CREATE TABLE "outbox_events"/u);
    expect(ddl).toMatch(/CREATE TABLE "processed_events"/u);
    expect(ddl).toMatch(/CREATE TABLE "event_versions"/u);
    expect(ddl).toMatch(/ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY/u);
    expect(ddl).toMatch(/CREATE POLICY "outbox_events_organization_isolation"/u);
    expect(ddl).toMatch(/"outbox_events_status_check" CHECK/u);
    expect(ddl).toMatch(
      /CREATE INDEX "outbox_events_pending_index".*"next_attempt_at".*WHERE.*'pending'/u,
    );
    expect(ddl).toMatch(/"subject" text NOT NULL/u);
    expect(ddl).toMatch(/"stream" text NOT NULL/u);
    expect(ddl).toMatch(/ALTER TABLE "event_versions" ENABLE ROW LEVEL SECURITY/u);
    expect(ddl).toMatch(/CREATE POLICY "event_versions_organization_isolation"/u);
    expect(ddl).toMatch(
      /"event_versions_aggregate_unique" UNIQUE NULLS NOT DISTINCT\("consumer","organization_id","aggregate_key"\)/u,
    );
    // drizzle-kit does not generate FORCE: a service adds it by hand, as the helper does here.
    expect(ddl).not.toMatch(/FORCE ROW LEVEL SECURITY/u);
  });

  it('runs as a role without DDL rights, under forced row-level security on the outbox and the versions', async () => {
    const role: { rows: unknown[] } = await pool.query(
      `select rolsuper, rolbypassrls, has_database_privilege(current_user, current_database(), 'CREATE') as can_create
         from pg_roles where rolname = current_user`,
    );
    const tables: { rows: unknown[] } = await database.admin.query(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
        where relname in ('outbox_events', 'event_versions') order by relname`,
    );

    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, can_create: false });
    expect(tables.rows).toEqual([
      { relname: 'event_versions', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'outbox_events', relrowsecurity: true, relforcerowsecurity: true },
    ]);
    await expect(pool.query('create table intruder (id int)')).rejects.toThrow(
      /permission denied/u,
    );
    await expect(pool.query('alter table outbox_events add column extra text')).rejects.toThrow(
      /must be owner/u,
    );
    await expect(pool.query('select id from outbox_events')).resolves.toMatchObject({ rows: [] });
  });

  it('appends a pending row whose id and instant come from PostgreSQL, with the trace context of the use case', async () => {
    const before: number = Date.now();
    const appended: AppendedEvent = await context.with(
      trace.setSpanContext(ROOT_CONTEXT, {
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        traceFlags: TraceFlags.SAMPLED,
      }),
      () =>
        as(ATELIER_NORD, () =>
          tenant.run((tx: TransactionScope) =>
            writer.append(tx, eventSchemas, 'task.updated.v1', taskUpdated({ version: 9 })),
          ),
        ),
    );
    const stored: Record<string, unknown>[] = await rows();

    expect(z.uuidv7().safeParse(appended.id).success).toBe(true);
    expect(Math.abs(Date.parse(appended.occurredAt) - before)).toBeLessThan(60_000);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: appended.id,
      event_name: 'task.updated.v1',
      subject: 'evt.task.updated.v1',
      stream: 'EVENTS',
      organization_id: ATELIER_NORD,
      payload: { ...taskUpdated({ version: 9 }), id: appended.id, occurredAt: appended.occurredAt },
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      status: 'pending',
      attempts: 0,
      last_error: null,
      sent_at: null,
    });
  });

  it('writes nothing when the use case rolls back', async () => {
    await expect(
      as(ATELIER_NORD, () =>
        tenant.run(async (tx: TransactionScope) => {
          await writer.append(tx, eventSchemas, 'task.updated.v1', taskUpdated());
          throw new Error('use case failed');
        }),
      ),
    ).rejects.toThrow('use case failed');

    expect(await rows()).toEqual([]);
  });

  it('writes nothing when the payload does not match its contract', async () => {
    await expect(
      as(ATELIER_NORD, () =>
        tenant.run((tx: TransactionScope) =>
          writer.append(tx, eventSchemas, 'task.updated.v1', taskUpdated({ version: 1.5 })),
        ),
      ),
    ).rejects.toThrow(EventValidationError);

    expect(await rows()).toEqual([]);
  });

  it('refuses an event of another organization in a tenant transaction, in the writer and in the policy', async () => {
    await expect(
      as(ATELIER_NORD, () =>
        tenant.run((tx: TransactionScope) =>
          writer.append(
            tx,
            eventSchemas,
            'task.updated.v1',
            taskUpdated({ organizationId: OTHER_ORGANIZATION }),
          ),
        ),
      ),
    ).rejects.toThrow(/does not belong to the organization of this transaction/u);
    await expect(
      as(ATELIER_NORD, () =>
        tenant.run((tx: TransactionScope) =>
          tx.client.query(
            `insert into outbox_events (id, event_name, subject, stream, organization_id, payload)
             values (uuidv7(), 'task.updated.v1', 'evt.task.updated.v1', 'EVENTS', $1, '{}'::jsonb)`,
            [OTHER_ORGANIZATION],
          ),
        ),
      ),
    ).rejects.toThrow(/row-level security policy/u);

    expect(await rows()).toEqual([]);
  });

  it('hides the outbox rows of another organization from a tenant transaction', async () => {
    await system.run(async (tx: TransactionScope) => {
      await writer.append(
        tx,
        eventSchemas,
        'task.updated.v1',
        taskUpdated({ organizationId: OTHER_ORGANIZATION }),
      );
      await writer.append(tx, eventSchemas, 'task.updated.v1', taskUpdated());
    });

    const visible: { rows: unknown[] } = await as(ATELIER_NORD, () =>
      tenant.run((tx: TransactionScope) =>
        tx.client.query('select organization_id from outbox_events'),
      ),
    );

    expect(visible.rows).toEqual([{ organization_id: ATELIER_NORD }]);
    expect(await rows()).toHaveLength(2);
  });

  it('appends an event without an organization in a system transaction only', async () => {
    await expect(
      as(ATELIER_NORD, () =>
        tenant.run((tx: TransactionScope) =>
          writer.append(tx, eventSchemas, 'user.signed-up.v1', userSignedUp()),
        ),
      ),
    ).rejects.toThrow(/appended in a system transaction/u);
    await expect(
      as(ATELIER_NORD, () =>
        tenant.run((tx: TransactionScope) =>
          tx.client.query(
            `insert into outbox_events (id, event_name, subject, stream, organization_id, payload)
             values (uuidv7(), 'user.signed-up.v1', 'evt.user.signed-up.v1', 'EVENTS', null, '{}'::jsonb)`,
          ),
        ),
      ),
    ).rejects.toThrow(/row-level security policy/u);

    const appended: AppendedEvent = await system.run((tx: TransactionScope) =>
      writer.append(tx, eventSchemas, 'user.signed-up.v1', userSignedUp()),
    );
    const stored: Record<string, unknown>[] = await rows();

    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: appended.id,
      event_name: 'user.signed-up.v1',
      subject: 'restricted.user.signed-up.v1',
      stream: 'EVENTS_RESTRICTED',
      organization_id: null,
      status: 'pending',
    });
  });

  it('refuses a status outside pending and sent', async () => {
    await expect(
      system.run((tx: TransactionScope) =>
        tx.client.query(
          `insert into outbox_events (id, event_name, subject, stream, organization_id, payload, status)
           values (uuidv7(), 'task.updated.v1', 'evt.task.updated.v1', 'EVENTS', $1, '{}'::jsonb, 'lost')`,
          [ATELIER_NORD],
        ),
      ),
    ).rejects.toThrow(/outbox_events_status_check/u);
  });
});
