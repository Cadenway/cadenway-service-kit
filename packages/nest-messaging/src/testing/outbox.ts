import { runWithOrganizationContext, type OrganizationContext } from '@cadenway/nest-common';
import {
  DatabaseModule,
  TenantTransactionRunner,
  type DatabaseSchema,
  type TransactionScope,
} from '@cadenway/nest-common/database';
import type { TestingModule } from '@nestjs/testing';

import type { MessagingModuleOptions } from '../configuration/messaging-options.js';
import type { MessagingTuning } from '../configuration/messaging-tuning.js';
import { MessagingModule } from '../wiring/messaging.module.js';
import eventVersions from '../outbox/schema/event-versions.schema.js';
import outboxEvents from '../outbox/schema/outbox-events.schema.js';
import type { OutboxModuleOptions } from '../outbox/wiring/outbox-options.js';
import { OutboxWriter, type AppendedEvent } from '../outbox/writer/outbox-writer.js';
import { OutboxModule } from '../outbox/wiring/outbox.module.js';
import processedEvents from '../outbox/schema/processed-events.schema.js';
import { messagingOptions, startApplication } from './application.js';
import { ATELIER_NORD, CAMILLE, eventSchemas, taskUpdated, type TaskUpdatedV1 } from './events.js';
import type { TestNats } from './nats.js';
import { kitMigration, type TestDatabase } from './postgres.js';

/**
 * Function asMember
 *
 * @description
 * Runs work in the organization context of a user of the given organization, as the
 * internal-token interceptor does for a request.
 *
 * @param {string} organizationId - Organization of the verified token.
 * @param {() => Promise<TResult>} work - Work to run.
 * @returns {Promise<TResult>} What the work returns.
 */
export function asMember<TResult>(
  organizationId: string,
  work: () => Promise<TResult>,
): Promise<TResult> {
  const organization: OrganizationContext = {
    organizationId,
    actor: { type: 'user', id: CAMILLE },
    role: 'member',
    scopes: [],
  };
  return runWithOrganizationContext(organization, work);
}

/**
 * Function migrateOutbox
 *
 * @description
 * Creates the three tables of the kit the way a service does: with the DDL drizzle-kit generates
 * from the exported tables, then `FORCE ROW LEVEL SECURITY` on the outbox and the versions,
 * added by hand.
 *
 * @param {TestDatabase} database - Disposable database.
 * @param {readonly string[]} extraStatements - DDL of the tables of the spec itself.
 * @returns {Promise<void>} Resolves once migrated.
 */
export async function migrateOutbox(
  database: TestDatabase,
  extraStatements: readonly string[] = [],
): Promise<void> {
  const statements: string[] = await kitMigration({ outboxEvents, processedEvents, eventVersions });
  await database.migrate([...statements, ...extraStatements], ['outbox_events', 'event_versions']);
}

/**
 * Function startService
 *
 * @description
 * Starts an application wired like a service with a database: `DatabaseModule`,
 * `MessagingModule` and `OutboxModule`. The relay polls every 50 ms and does not purge unless
 * the spec asks for it.
 *
 * @param {TestDatabase} database - Disposable database, reached with the application role.
 * @param {TestNats} nats - Disposable NATS server.
 * @param {Partial<MessagingModuleOptions>} messaging - Messaging options of the spec.
 * @param {OutboxModuleOptions} outbox - Outbox options of the spec.
 * @param {Partial<MessagingTuning>} tuning - Timings of the kit to change.
 * @returns {Promise<TestingModule>} The running application.
 */
export function startService(
  database: TestDatabase,
  nats: TestNats,
  messaging: Partial<MessagingModuleOptions> = {},
  outbox: OutboxModuleOptions = {},
  tuning: Partial<MessagingTuning> = {},
): Promise<TestingModule> {
  return startApplication(
    [
      DatabaseModule.forRoot({ connectionString: database.appUrl, poolSize: 4 }),
      MessagingModule.forRoot(messagingOptions(nats, messaging)),
      OutboxModule.forRoot({ pollIntervalMs: 50, purgeIntervalMs: 0, ...outbox }),
    ],
    { tuning },
  );
}

/**
 * Function appendTaskUpdated
 *
 * @description
 * Runs a use case of the first organization that appends one `task.updated.v1` event to the
 * outbox and commits.
 *
 * @param {TestingModule} application - Application started with `startService`.
 * @param {Partial<Omit<TaskUpdatedV1, 'id' | 'occurredAt'>>} overrides - Fields that differ from the default fixture.
 * @returns {Promise<AppendedEvent>} The id and the instant of the event.
 */
export function appendTaskUpdated(
  application: TestingModule,
  overrides: Partial<Omit<TaskUpdatedV1, 'id' | 'occurredAt'>> = {},
): Promise<AppendedEvent> {
  return asMember(overrides.organizationId ?? ATELIER_NORD, () =>
    application
      .get(TenantTransactionRunner)
      .run((tx: TransactionScope<DatabaseSchema>) =>
        application
          .get(OutboxWriter)
          .append(tx, eventSchemas, 'task.updated.v1', taskUpdated(overrides)),
      ),
  );
}
