import type { DatabaseSchema, TransactionScope } from '@cadenway/nest-common/database';
import { Inject, Injectable } from '@nestjs/common';

import type {
  EventDataOf,
  EventNameOf,
  EventPayloadOf,
  EventSchemas,
} from '../../events/event-envelope.js';
import { validateEvent } from '../../events/event-validation.js';
import { eventRoute, type EventRoute } from '../../transport/event-route.js';
import {
  MESSAGING_OPTIONS,
  type ResolvedMessagingOptions,
} from '../../configuration/messaging-options.js';
import { currentTraceparent } from '../../observability/trace-context.js';

/**
 * Interface AppendedEvent
 *
 * @description
 * Identity and occurrence time assigned by PostgreSQL to an outbox event.
 */
export interface AppendedEvent {
  // #region Properties
  /**
   * Property id
   *
   * @description
   * UUID version 7 used to deduplicate publication and delivery.
   *
   * @type {string}
   * @readonly
   */
  readonly id: string;

  /**
   * Property occurredAt
   *
   * @description
   * Start of the writing transaction as an ISO 8601 date-time in UTC.
   *
   * @type {string}
   * @readonly
   */
  readonly occurredAt: string;
  // #endregion
}

/**
 * Class OutboxWriter
 *
 * @description
 * Appends events inside the caller's transaction. The relay can publish an event only after
 * that transaction commits.
 */
@Injectable()
export class OutboxWriter {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Uses the writer's messaging configuration to choose the event route.
   *
   * @param {ResolvedMessagingOptions} options - Resolved routing configuration used to persist the event’s subject and stream.
   * @constructor
   */
  public constructor(
    @Inject(MESSAGING_OPTIONS) private readonly options: ResolvedMessagingOptions,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Method append
   *
   * @description
   * Completes and validates the event before writing its trace context and route. Persisting the
   * route keeps a restricted event restricted under a different relay configuration.
   *
   * A tenant transaction may append events only for its own organization. A system transaction
   * can append events across organizations and events without an organization.
   *
   * @param {TransactionScope<TDatabase>} tx - Caller-owned tenant or system transaction that also records the business change.
   * @param {TSchemas} schemas - Event schema map from the relevant `@cadenway/contracts` module.
   * @param {TName} name - Contract name used to validate and route the event.
   * @param {EventDataOf<TSchemas, TName>} data - Payload without the ID and occurrence time assigned by PostgreSQL.
   * @returns {Promise<AppendedEvent>} Event ID and occurrence time persisted by the writer.
   * @throws {EventValidationError} When the payload fails validation. The error omits its values.
   * @throws {Error} When a tenant transaction is given an event of another organization or of none.
   */
  public async append<
    TDatabase extends DatabaseSchema,
    TSchemas extends EventSchemas,
    TName extends EventNameOf<TSchemas>,
  >(
    tx: TransactionScope<TDatabase>,
    schemas: TSchemas,
    name: TName,
    data: EventDataOf<TSchemas, TName>,
  ): Promise<AppendedEvent> {
    // The instant is formatted by PostgreSQL so it does not depend on the type parsers of the
    // driver.
    const assigned: { rows: unknown[] } = await tx.client.query(
      `select uuidv7()::text as id,
              to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at`,
    );
    const row: { id: string; occurred_at: string } = assigned.rows[0] as {
      id: string;
      occurred_at: string;
    };
    const payload: EventPayloadOf<TSchemas, TName> = validateEvent(schemas, name, {
      ...data,
      id: row.id,
      occurredAt: row.occurred_at,
    });
    const route: EventRoute = eventRoute(this.options, name);
    if (tx.kind === 'tenant' && payload.organizationId !== tx.organizationId) {
      throw new Error(
        `The event ${name} does not belong to the organization of this transaction: an event of another organization or without one is appended in a system transaction.`,
      );
    }
    await tx.client.query(
      `insert into outbox_events
         (id, event_name, subject, stream, organization_id, payload, traceparent)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        payload.id,
        name,
        route.subject,
        route.stream,
        payload.organizationId,
        JSON.stringify(payload),
        currentTraceparent(),
      ],
    );
    return { id: payload.id, occurredAt: payload.occurredAt };
  }
  // #endregion
}
