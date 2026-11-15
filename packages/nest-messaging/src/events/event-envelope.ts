import { z } from 'zod';

/**
 * Type EventActorType
 *
 * @description
 * Kinds of actor this version of the kit knows, the ones the contracts define today. The
 * envelope accepts any string, so a minor of `@cadenway/contracts` that adds a kind still
 * compiles; the consumers narrow to these when they open the organization context.
 *
 * @type {'user' | 'automation' | 'git' | 'system'}
 */
export type EventActorType = 'user' | 'automation' | 'git' | 'system';

/**
 * Constant EVENT_ACTOR_TYPES
 *
 * @description
 * Kinds of actor this version of the kit knows.
 *
 * @type {readonly EventActorType[]}
 */
export const EVENT_ACTOR_TYPES: readonly EventActorType[] = ['user', 'automation', 'git', 'system'];

/**
 * Interface EventActor
 *
 * @description
 * Who caused an event, as every event contract carries it.
 */
export interface EventActor {
  // #region Properties
  /**
   * Property type
   *
   * @description
   * Kind of actor, such as `user`. Typed as a string so that a kind added by the contracts does
   * not break the compilation of a service; see `EventActorType` for the kinds the kit knows.
   *
   * @type {string}
   * @readonly
   */
  readonly type: string;

  /**
   * Property id
   *
   * @description
   * Id of the user, the automation rule, the Git integration or the service.
   *
   * @type {string}
   * @readonly
   */
  readonly id: string;
  // #endregion
}

/**
 * Interface EventEnvelope
 *
 * @description
 * Fields every event payload of `@cadenway/contracts` carries, whatever the event. The kit reads
 * these and nothing else of a payload.
 */
export interface EventEnvelope {
  // #region Properties
  /**
   * Property id
   *
   * @description
   * Id of the event, a UUID: the deduplication key, also sent as `Nats-Msg-Id`.
   *
   * @type {string}
   * @readonly
   */
  readonly id: string;

  /**
   * Property occurredAt
   *
   * @description
   * Instant of the event, as an ISO 8601 date-time.
   *
   * @type {string}
   * @readonly
   */
  readonly occurredAt: string;

  /**
   * Property organizationId
   *
   * @description
   * Organization the event belongs to, or `null` for an event outside any organization, such as
   * `user.signed-up.v1`.
   *
   * @type {string | null}
   * @readonly
   */
  readonly organizationId: string | null;

  /**
   * Property actor
   *
   * @description
   * Who caused the event.
   *
   * @type {EventActor}
   * @readonly
   */
  readonly actor: EventActor;

  /**
   * Property version
   *
   * @description
   * Version of the aggregate after the change, an integer. A consumer skips a version it has
   * already applied.
   *
   * @type {number}
   * @readonly
   */
  readonly version: number;
  // #endregion
}

/**
 * Type EventSchemas
 *
 * @description
 * Shape of the `eventSchemas` object an event module of `@cadenway/contracts` exports
 * (`@cadenway/contracts/events/<spec>`): the zod validator of each event, by event name. The kit
 * is generic over it, so the event names and the payload types of a call come from the contracts.
 *
 * @type {Readonly<Record<string, z.ZodType<EventEnvelope>>>}
 */
export type EventSchemas = Readonly<Record<string, z.ZodType<EventEnvelope>>>;

/**
 * Type EventNameOf
 *
 * @description
 * Names of the events of an `eventSchemas` object.
 *
 * @type {Extract<keyof TSchemas, string>}
 */
export type EventNameOf<TSchemas extends EventSchemas> = Extract<keyof TSchemas, string>;

/**
 * Type EventPayloadOf
 *
 * @description
 * Payload of one event of an `eventSchemas` object, as its validator returns it.
 *
 * @type {z.output<TSchemas[TName]>}
 */
export type EventPayloadOf<
  TSchemas extends EventSchemas,
  TName extends EventNameOf<TSchemas>,
> = z.output<TSchemas[TName]>;

/**
 * Type EventDataOf
 *
 * @description
 * What a caller gives to publish an event: its payload without `id` and `occurredAt`, which the
 * kit assigns. The omission distributes over a union, so a payload that is a discriminated union
 * keeps its variants.
 *
 * @type {DistributiveOmit<EventPayloadOf<TSchemas, TName>, 'id' | 'occurredAt'>}
 */
export type EventDataOf<
  TSchemas extends EventSchemas,
  TName extends EventNameOf<TSchemas>,
> = DistributiveOmit<EventPayloadOf<TSchemas, TName>, 'id' | 'occurredAt'>;

/**
 * Type DistributiveOmit
 *
 * @description
 * `Omit` applied to each member of a union separately.
 *
 * @type {TValue extends unknown ? Omit<TValue, TKeys> : never}
 */
export type DistributiveOmit<TValue, TKeys extends PropertyKey> = TValue extends unknown
  ? Omit<TValue, TKeys>
  : never;
