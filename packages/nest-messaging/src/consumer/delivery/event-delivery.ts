import {
  runWithOrganizationContext,
  type InternalActor,
  type OrganizationContext,
} from '@cadenway/nest-common';
import type { JsMsg } from '@nats-io/jetstream';
import type { Logger } from '@nestjs/common';
import {
  context,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
} from '@opentelemetry/api';

import { errorCategoryOf } from '../../observability/error-class.js';
import {
  EVENT_ACTOR_TYPES,
  type EventActor,
  type EventActorType,
  type EventEnvelope,
} from '../../events/event-envelope.js';
import { EventValidationError } from '../../events/event-validation-error.js';
import { contextFromTraceparent } from '../../observability/trace-context.js';
import { TRACEPARENT_HEADER } from '../../transport/event-headers.js';
import type {
  DeduplicationOutcome,
  EventDeduplicator,
  VersionClaim,
} from './event-deduplicator.js';
import { retryDelayMs } from './retry-delays.js';
import type { EventTarget, PreparedEvent } from '../subscriptions/event-target.js';
import type { EventContext } from './event-context.js';
import { HandlerTimeoutError } from './handler-timeout-error.js';

/**
 * Function alwaysApply
 *
 * @description
 * Version claim of an application without a deduplicator: there is no version store, so every
 * event is applied.
 *
 * @returns {Promise<boolean>} Always `true`.
 */
function alwaysApply(): Promise<boolean> {
  return Promise.resolve(true);
}

/**
 * Function untilAborted
 *
 * @description
 * Settles like a promise, or rejects with the reason of a signal as soon as it is aborted. The
 * work itself is not stopped: it is abandoned.
 *
 * @param {Promise<TResult>} work - Work to wait for.
 * @param {AbortSignal} signal - Signal of the deadline.
 * @returns {Promise<TResult>} What the work returns, unless the signal is aborted first.
 */
function untilAborted<TResult>(work: Promise<TResult>, signal: AbortSignal): Promise<TResult> {
  const reasonOf: () => Error = (): Error =>
    signal.reason instanceof Error ? signal.reason : new Error('The work was aborted.');
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(reasonOf());
  }
  return new Promise<TResult>(
    (resolve: (value: TResult) => void, reject: (reason: Error) => void) => {
      const onAbort: () => void = (): void => {
        reject(reasonOf());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        (value: TResult) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error instanceof Error ? error : new Error('The event work failed.'));
        },
      );
    },
  );
}

/**
 * Function answerSafely
 *
 * @description
 * Sends the answer to a message (`ack`, `nak` or `term`). The connection may have closed while
 * the handler ran: the answer is then lost, the server redelivers the message, and the failure is
 * reported to `onError` instead of thrown.
 *
 * @param {() => void} answer - Sends the answer.
 * @param {(error: unknown) => void} onError - Called when the answer could not be sent.
 */
export function answerSafely(answer: () => void, onError: (error: unknown) => void): void {
  try {
    answer();
  } catch (error) {
    onError(error);
  }
}

/**
 * Function contextActorOf
 *
 * @description
 * Narrows the actor of an envelope to the actor of an organization context. A kind of actor this
 * version of the kit does not know becomes the system, without identity.
 *
 * @param {EventActor} actor - Actor of the validated envelope.
 * @returns {InternalActor | undefined} The actor of the context, or `undefined` when its kind is unknown.
 */
export function contextActorOf(actor: EventActor): InternalActor | undefined {
  return (EVENT_ACTOR_TYPES as readonly string[]).includes(actor.type)
    ? { type: actor.type as EventActorType, id: actor.id }
    : undefined;
}

/**
 * Class EventDelivery
 *
 * @description
 * Validates one delivery, scopes its handler to the event context and deadline, and answers the message.
 */
export class EventDelivery {
  // #region Properties
  /**
   * Property unknownActors
   *
   * @description
   * Consumer and actor kind pairs already logged.
   *
   * @type {Set<string>}
   * @readonly
   */
  private readonly unknownActors: Set<string> = new Set<string>();
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Sets the delivery deadline for all consumers of the application; each target carries its own
   * redelivery schedule.
   *
   * @param {Logger} logger - Shared consumer logger.
   * @param {number} handlerTimeoutMs - Handler deadline in milliseconds.
   * @param {EventDeduplicator | undefined} deduplicator - Optional transaction around the handler.
   * @param {AbortSignal | undefined} abandon - Signal triggered when the shutdown grace period expires.
   * @constructor
   */
  public constructor(
    private readonly logger: Logger,
    private readonly handlerTimeoutMs: number,
    private readonly deduplicator?: EventDeduplicator,
    private readonly abandon?: AbortSignal,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Method deliver
   *
   * @description
   * Validates one delivery and runs the handler in its organization context. A success is
   * acknowledged after deduplication commits, invalid input is terminated, and handler failure
   * uses the redelivery schedule of the target. Once shutdown grace expires, the delivery is left unsettled
   * for JetStream to redeliver.
   *
   * @param {EventTarget} target - Registered durable handler and its validation boundary.
   * @param {JsMsg} message - JetStream delivery whose settlement is decided here.
   * @returns {Promise<void>} Resolves when settlement is attempted or shutdown leaves the delivery unacknowledged.
   */
  public async deliver(target: EventTarget, message: JsMsg): Promise<void> {
    if (this.isAbandoned()) {
      return;
    }
    const deliveryCount: number = message.info.deliveryCount;
    const streamSequence: number = message.info.streamSequence;
    const fields: {
      event: string;
      consumer: string;
      streamSequence: number;
      deliveryCount: number;
    } = { event: target.event, consumer: target.consumer, streamSequence, deliveryCount };
    let prepared: PreparedEvent;
    try {
      const decoded: unknown = JSON.parse(message.string());
      prepared = target.prepare(decoded);
    } catch (error) {
      const invalid: boolean = error instanceof EventValidationError;
      this.answer(target, message, 'term', invalid ? 'invalid-payload' : 'invalid-json');
      this.logger.error(
        { ...fields, issues: error instanceof EventValidationError ? error.issues : undefined },
        invalid ? 'event does not match its contract: terminated' : 'event is not JSON: terminated',
      );
      return;
    }
    const payload: EventEnvelope = prepared.envelope;
    const parent: Context = contextFromTraceparent(message.headers?.get(TRACEPARENT_HEADER));
    const span: Span = trace.getTracer('@cadenway/nest-messaging').startSpan(
      `process ${target.event}`,
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          'messaging.system': 'nats',
          'messaging.operation.type': 'process',
          'messaging.destination.name': message.subject,
          'messaging.consumer.group.name': target.consumer,
          'messaging.message.id': payload.id,
        },
      },
      parent,
    );
    const deadline: AbortController = new AbortController();
    const timer: NodeJS.Timeout = setTimeout(() => {
      deadline.abort(new HandlerTimeoutError(this.handlerTimeoutMs));
    }, this.handlerTimeoutMs);
    const eventContext: Omit<EventContext, 'claimVersion'> = {
      deliveryCount,
      streamSequence,
      redelivered: message.redelivered,
      signal:
        this.abandon === undefined
          ? deadline.signal
          : AbortSignal.any([deadline.signal, this.abandon]),
    };
    try {
      const outcome: DeduplicationOutcome = await context.with(trace.setSpan(parent, span), () =>
        runWithOrganizationContext(this.organizationContextOf(target, payload), () =>
          untilAborted(this.handle(target, prepared, eventContext), eventContext.signal),
        ),
      );
      eventContext.signal.throwIfAborted();
      this.answer(target, message, 'ack');
      if (outcome === 'duplicate') {
        this.logger.debug({ ...fields, eventId: payload.id }, 'duplicate event skipped');
      }
    } catch (error) {
      if (this.isAbandoned()) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'ShutdownAbandoned' });
        return;
      }
      const timedOut: boolean = error instanceof HandlerTimeoutError;
      const errorClass: string = timedOut ? 'HandlerTimeoutError' : errorCategoryOf(error);
      span.setAttribute('error.type', errorClass);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorClass });
      const delayMs: number | undefined = retryDelayMs(
        deliveryCount,
        target.redelivery.delaysMs,
        target.redelivery.maxDeliveries,
      );
      if (delayMs === undefined) {
        this.answer(target, message, 'nak');
        this.logger.error(
          { ...fields, eventId: payload.id, errorClass },
          'event handler failed on the last delivery: dead letter',
        );
      } else {
        this.answer(target, message, 'nak', delayMs);
        this.logger.warn(
          { ...fields, eventId: payload.id, retryInMs: delayMs, errorClass },
          timedOut ? 'event handler timed out: will retry' : 'event handler failed: will retry',
        );
      }
    } finally {
      clearTimeout(timer);
      span.end();
    }
  }

  /**
   * Method isAbandoned
   *
   * @description
   * Reads the current shutdown deadline, which can expire while awaiting a handler.
   *
   * @returns {boolean} Whether in-flight deliveries are past the shutdown grace period.
   */
  private isAbandoned(): boolean {
    return this.abandon?.aborted === true;
  }

  /**
   * Method answer
   *
   * @description
   * Sends the delivery outcome to JetStream.
   *
   * @param {EventTarget} target - Registered handler.
   * @param {JsMsg} message - Message delivered by JetStream.
   * @param {'ack' | 'term' | 'nak'} answer - Answer to send.
   * @param {string | number | undefined} detail - Reason of a `term`; delay of a `nak`, in milliseconds, none asking for an immediate redelivery.
   */
  private answer(
    target: EventTarget,
    message: JsMsg,
    answer: 'ack' | 'term' | 'nak',
    detail?: string | number,
  ): void {
    answerSafely(
      () => {
        if (answer === 'ack') {
          message.ack();
        } else if (answer === 'term') {
          message.term(typeof detail === 'string' ? detail : undefined);
        } else {
          message.nak(typeof detail === 'number' ? detail : undefined);
        }
      },
      (error: unknown) => {
        this.logger.debug(
          {
            consumer: target.consumer,
            streamSequence: message.info.streamSequence,
            errorClass: errorCategoryOf(error),
          },
          'the answer to a message could not be sent: it will be redelivered',
        );
      },
    );
  }

  /**
   * Method organizationContextOf
   *
   * @description
   * Builds the organization context of a delivery from its validated envelope. An actor kind
   * this version of the kit does not know opens the context as the system, without identity,
   * and is logged once per consumer and kind: upgrade the kit when the contracts add one.
   *
   * @param {EventTarget} target - Registered handler.
   * @param {EventEnvelope} payload - Validated payload.
   * @returns {OrganizationContext} The organization context.
   */
  private organizationContextOf(target: EventTarget, payload: EventEnvelope): OrganizationContext {
    let actor: InternalActor | undefined = contextActorOf(payload.actor);
    if (actor === undefined) {
      const key: string = `${target.consumer}|${payload.actor.type}`;
      if (!this.unknownActors.has(key)) {
        this.unknownActors.add(key);
        this.logger.warn(
          { consumer: target.consumer, actorType: payload.actor.type.slice(0, 64) },
          'unknown actor type: handled as the system; upgrade @cadenway/nest-messaging',
        );
      }
      actor = { type: 'system', id: null };
    }
    return { organizationId: payload.organizationId, actor, role: null, scopes: [] };
  }

  /**
   * Method handle
   *
   * @description
   * Makes the transaction roll back when an active handler exceeds its deadline.
   *
   * @param {EventTarget} target - Durable target used to scope deduplication.
   * @param {PreparedEvent} prepared - Validated event and the callback bound to its typed data.
   * @param {Omit<EventContext, 'claimVersion'>} eventContext - Delivery metadata and cancellation signal passed to the handler.
   * @returns {Promise<DeduplicationOutcome>} Resolves to the deduplication outcome after the handler or duplicate check succeeds.
   */
  private async handle(
    target: EventTarget,
    prepared: PreparedEvent,
    eventContext: Omit<EventContext, 'claimVersion'>,
  ): Promise<DeduplicationOutcome> {
    const handle = async (claimVersion: VersionClaim): Promise<void> => {
      eventContext.signal.throwIfAborted();
      await untilAborted(prepared.handle({ ...eventContext, claimVersion }), eventContext.signal);
    };
    if (this.deduplicator === undefined) {
      await handle(alwaysApply);
      return 'handled';
    }
    return this.deduplicator.run(
      {
        consumer: target.consumer,
        event: target.event,
        envelope: prepared.envelope,
        ...(target.transactionIsolationLevel === undefined
          ? {}
          : { transactionIsolationLevel: target.transactionIsolationLevel }),
      },
      handle,
    );
  }
  // #endregion
}
