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

import { errorClassOf } from '../../observability/error-class.js';
import {
  EVENT_ACTOR_TYPES,
  type EventActor,
  type EventActorType,
  type EventEnvelope,
} from '../../events/event-envelope.js';
import { EventValidationError } from '../../events/event-validation.js';
import { contextFromTraceparent } from '../../observability/trace-context.js';
import { TRACEPARENT_HEADER } from '../../transport/event-headers.js';
import type {
  DeduplicationOutcome,
  EventDeduplicator,
  VersionClaim,
} from './event-deduplicator.js';
import { retryDelayMs } from './retry-delays.js';
import type { EventTarget } from '../subscriptions/event-target.js';
import type { EventContext } from './event-context.js';

/**
 * Class HandlerTimeoutError
 *
 * @description
 * Reason of the `signal` of a handler aborted at `handlerTimeoutMs`, and error of the abandoned
 * attempt.
 */
class HandlerTimeoutError extends Error {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Builds the error.
   *
   * @param {number} timeoutMs - Deadline that was reached, in milliseconds.
   * @constructor
   */
  public constructor(timeoutMs: number) {
    super(`The event handler did not finish within ${String(timeoutMs)} ms.`);
    this.name = 'HandlerTimeoutError';
  }
  // #endregion
}

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
          reject(error instanceof Error ? error : new Error(String(error)));
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
 * @returns {void}
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
   * Sets the delivery deadline and retry policy for all consumers of the application.
   *
   * @param {Logger} logger - Shared consumer logger.
   * @param {number} handlerTimeoutMs - Handler deadline in milliseconds.
   * @param {readonly number[]} retryDelaysMs - Delays by failed attempt, in milliseconds.
   * @param {EventDeduplicator | undefined} deduplicator - Optional transaction around the handler.
   * @constructor
   */
  public constructor(
    private readonly logger: Logger,
    private readonly handlerTimeoutMs: number,
    private readonly retryDelaysMs: readonly number[],
    private readonly deduplicator?: EventDeduplicator,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Method deliver
   *
   * @description
   * Processes one delivery: validates the message, runs the handler inside the organization
   * context of the event and a consumer span, within `handlerTimeoutMs`, then acknowledges,
   * retries or terminates.
   *
   * A message that is not valid JSON or does not match its contract can never succeed: it is
   * terminated, which makes it a dead letter at once. A handler failure or timeout asks for a
   * redelivery after the delay of that attempt; on the last attempt the redelivery is asked for
   * at once, which makes the server report the delivery limit. The span records the class of
   * the error only, never its message.
   *
   * @param {EventTarget} target - Registered handler.
   * @param {JsMsg} message - Message delivered by JetStream.
   * @returns {Promise<void>} Resolves once the message was answered; it never rejects.
   */
  public async deliver(target: EventTarget, message: JsMsg): Promise<void> {
    const deliveryCount: number = message.info.deliveryCount;
    const streamSequence: number = message.info.streamSequence;
    const fields: {
      event: string;
      consumer: string;
      streamSequence: number;
      deliveryCount: number;
    } = { event: target.event, consumer: target.consumer, streamSequence, deliveryCount };
    let payload: EventEnvelope;
    try {
      const decoded: unknown = JSON.parse(message.string());
      payload = target.validate(decoded);
    } catch (error) {
      const invalid: boolean = error instanceof EventValidationError;
      this.answer(target, message, 'term', invalid ? 'invalid-payload' : 'invalid-json');
      this.logger.error(
        { ...fields, issues: error instanceof EventValidationError ? error.issues : undefined },
        invalid ? 'event does not match its contract: terminated' : 'event is not JSON: terminated',
      );
      return;
    }
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
      signal: deadline.signal,
    };
    try {
      const outcome: DeduplicationOutcome = await context.with(trace.setSpan(parent, span), () =>
        runWithOrganizationContext(this.organizationContextOf(target, payload), () =>
          untilAborted(this.handle(target, payload, eventContext), deadline.signal),
        ),
      );
      this.answer(target, message, 'ack');
      if (outcome === 'duplicate') {
        this.logger.debug({ ...fields, eventId: payload.id }, 'duplicate event skipped');
      }
    } catch (error) {
      const errorClass: string = errorClassOf(error);
      span.setAttribute('error.type', errorClass);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorClass });
      const timedOut: boolean = error instanceof HandlerTimeoutError;
      const delayMs: number | undefined = retryDelayMs(deliveryCount, this.retryDelaysMs);
      if (delayMs === undefined) {
        this.answer(target, message, 'nak');
        this.logger.error(
          { ...fields, eventId: payload.id, err: error },
          'event handler failed on the last delivery: dead letter',
        );
      } else {
        this.answer(target, message, 'nak', delayMs);
        this.logger.warn(
          { ...fields, eventId: payload.id, retryInMs: delayMs, err: error },
          timedOut ? 'event handler timed out: will retry' : 'event handler failed: will retry',
        );
      }
    } finally {
      clearTimeout(timer);
      span.end();
    }
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
   * @returns {void}
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
          { consumer: target.consumer, streamSequence: message.info.streamSequence, err: error },
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
   * Calls the handler, through the deduplicator when the application has one. The deadline
   * prevents a late start and abandons a running handler so the transaction rolls back.
   *
   * @param {EventTarget} target - Registered handler.
   * @param {EventEnvelope} payload - Validated payload.
   * @param {Omit<EventContext, 'claimVersion'>} eventContext - Delivery details and deadline signal.
   * @returns {Promise<DeduplicationOutcome>} `handled`, or `duplicate` when the deduplicator skipped the handler.
   */
  private async handle(
    target: EventTarget,
    payload: EventEnvelope,
    eventContext: Omit<EventContext, 'claimVersion'>,
  ): Promise<DeduplicationOutcome> {
    if (this.deduplicator === undefined) {
      await target.handle(payload, { ...eventContext, claimVersion: alwaysApply });
      return 'handled';
    }
    return this.deduplicator.run(
      { consumer: target.consumer, event: target.event, envelope: payload },
      async (claimVersion: VersionClaim): Promise<void> => {
        eventContext.signal.throwIfAborted();
        await untilAborted(
          target.handle(payload, { ...eventContext, claimVersion }),
          eventContext.signal,
        );
      },
    );
  }
  // #endregion
}
