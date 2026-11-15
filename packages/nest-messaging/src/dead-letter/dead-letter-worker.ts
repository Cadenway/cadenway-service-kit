import type { JetStreamManager, StoredMsg } from '@nats-io/jetstream';
import { headers, type Msg, type MsgHdrs, type Subscription } from '@nats-io/transport-node';
import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { z } from 'zod';

import { MessagingConnection } from '../connection/messaging-connection.js';
import { errorClassOf } from '../error-class.js';
import { MESSAGING_OPTIONS, type ResolvedMessagingOptions } from '../messaging-options.js';
import { MESSAGING_TUNING, type MessagingTuning } from '../messaging-tuning.js';
import {
  DEAD_LETTER_CONSUMER_HEADER,
  DEAD_LETTER_DELIVERIES_HEADER,
  DEAD_LETTER_PAYLOAD_HEADER,
  DEAD_LETTER_REASON_HEADER,
  DEAD_LETTER_SEQUENCE_HEADER,
  EVENT_NAME_HEADER,
} from '../publisher/event-headers.js';
import {
  deadLetterMessageId,
  deadLetterSubject,
  maxDeliveriesAdvisorySubject,
  terminatedAdvisorySubject,
} from '../subjects.js';

/**
 * Type DeadLetterReason
 *
 * @description
 * Why a message became a dead letter: a consumer delivered it as many times as allowed without
 * an acknowledgement, or a consumer terminated it because it can never be handled.
 *
 * @type {'max-deliveries' | 'terminated'}
 */
export type DeadLetterReason = 'max-deliveries' | 'terminated';

/**
 * Interface ConsumerAdvisory
 *
 * @description
 * Fields the worker reads in the two consumer advisories of JetStream,
 * `io.nats.jetstream.advisory.v1.max_deliver` and `io.nats.jetstream.advisory.v1.terminated`.
 */
interface ConsumerAdvisory {
  // #region Properties
  /**
   * Property stream
   *
   * @description
   * Stream the message is stored in.
   *
   * @type {string}
   * @readonly
   */
  readonly stream: string;

  /**
   * Property consumer
   *
   * @description
   * Durable consumer that gave up on the message.
   *
   * @type {string}
   * @readonly
   */
  readonly consumer: string;

  /**
   * Property stream_seq
   *
   * @description
   * Sequence of the message in the stream.
   *
   * @type {number}
   * @readonly
   */
  readonly stream_seq: number;

  /**
   * Property deliveries
   *
   * @description
   * How many times the message was delivered to the consumer.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly deliveries?: number;

  /**
   * Property reason
   *
   * @description
   * Reason the consumer gave when it terminated the message. Absent from a delivery-limit
   * advisory.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly reason?: string;
  // #endregion
}

/**
 * Constant advisorySchema
 *
 * @description
 * Validator of the fields read in a consumer advisory. Unknown fields are ignored.
 *
 * @type {z.ZodType<ConsumerAdvisory>}
 */
const advisorySchema: z.ZodType<ConsumerAdvisory> = z.object({
  stream: z.string(),
  consumer: z.string(),
  stream_seq: z.number().int().positive(),
  deliveries: z.number().int().optional(),
  reason: z.string().optional(),
});

/**
 * Constant NOT_COPIED_HEADER
 *
 * @description
 * Shape of the headers of the original message that are not copied to its dead letter: the
 * message id and the publish expectations, which belong to the first publication.
 *
 * @type {RegExp}
 */
const NOT_COPIED_HEADER: RegExp = /^nats-(?:msg-id|expected-.+)$/iu;

/**
 * Constant KNOWN_TERMINATION_REASONS
 *
 * @description
 * Termination reasons the consumers of the kit send, logged as they are.
 *
 * @type {ReadonlySet<string>}
 */
const KNOWN_TERMINATION_REASONS: ReadonlySet<string> = new Set<string>([
  'invalid-payload',
  'invalid-json',
]);

/**
 * Function boundedReason
 *
 * @description
 * Makes a termination reason safe to log: a reason the kit sends is kept, any other one, which
 * another client chose, is cut to 64 printable characters.
 *
 * @param {string | undefined} reason - Reason of the advisory.
 * @returns {string | undefined} The reason to log, or `undefined` when there is none.
 */
export function boundedReason(reason: string | undefined): string | undefined {
  if (reason === undefined || KNOWN_TERMINATION_REASONS.has(reason)) {
    return reason;
  }
  return reason.replace(/[^\x20-\x7e]/gu, '?').slice(0, 64);
}

/**
 * Interface DeadLetter
 *
 * @description
 * A dead letter to store, read from its advisory.
 */
interface DeadLetter {
  // #region Properties
  /**
   * Property reason
   *
   * @description
   * Why the message is a dead letter.
   *
   * @type {DeadLetterReason}
   * @readonly
   */
  readonly reason: DeadLetterReason;

  /**
   * Property advisory
   *
   * @description
   * Fields of the advisory.
   *
   * @type {ConsumerAdvisory}
   * @readonly
   */
  readonly advisory: ConsumerAdvisory;
  // #endregion
}

/**
 * Class DeadLetterWorker
 *
 * @description
 * Copies dead letters into the dead-letter stream. JetStream has no dead-letter queue: when a
 * consumer of the events stream or of the restricted stream reaches its delivery limit or
 * terminates a message, the server publishes an advisory, and this worker reads the original
 * message from its stream by sequence and republishes it on `dlq.<consumer>.<original subject>`
 * with the original headers plus the consumer, the reason, the sequence and the delivery count.
 * The copy of a restricted event has an empty body unless `restrictedDeadLetterPayload` is
 * `copy`.
 *
 * The worker runs only when `deadLetterWorker` is on, in notification-service only: reading a
 * message by sequence includes the restricted ones, which no other service may see. Its
 * replicas share the advisories through a queue group, and the `Nats-Msg-Id` of a dead
 * letter is derived from the consumer and the sequence, so an advisory seen twice is stored
 * once. A copy that fails is tried five times over about two minutes. Advisories are plain NATS
 * messages: one published while no worker is connected is lost, and the message then stays in
 * its stream until it expires.
 */
@Injectable()
export class DeadLetterWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  // #region Properties
  /**
   * Property logger
   *
   * @description
   * Logger of the dead letters. It never receives a payload.
   *
   * @type {Logger}
   * @readonly
   */
  private readonly logger: Logger = new Logger('DeadLetterWorker');

  /**
   * Property subscriptions
   *
   * @description
   * Advisory subscriptions of the running worker.
   *
   * @type {Subscription[]}
   * @readonly
   */
  private readonly subscriptions: Subscription[] = [];

  /**
   * Property running
   *
   * @description
   * Loops of the running worker, one per advisory subject.
   *
   * @type {Promise<void>[]}
   * @readonly
   */
  private readonly running: Promise<void>[] = [];

  /**
   * Property stop
   *
   * @description
   * Aborted on shutdown: a copy waiting for its next attempt gives up.
   *
   * @type {AbortController}
   * @readonly
   */
  private readonly stop: AbortController = new AbortController();
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Stores the connection, the options and the timings.
   *
   * @param {MessagingConnection} connection - NATS connection of the application.
   * @param {ResolvedMessagingOptions} options - Options of the module.
   * @param {MessagingTuning} tuning - Delays between the attempts of a copy.
   * @constructor
   */
  public constructor(
    private readonly connection: MessagingConnection,
    @Inject(MESSAGING_OPTIONS) private readonly options: ResolvedMessagingOptions,
    @Inject(MESSAGING_TUNING) private readonly tuning: MessagingTuning,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Method onApplicationBootstrap
   *
   * @description
   * Subscribes, when the worker is enabled, to the delivery-limit and termination advisories of
   * the events stream and of the restricted stream.
   *
   * @returns {Promise<void>} Resolves once the server knows the subscriptions.
   */
  public async onApplicationBootstrap(): Promise<void> {
    if (!this.options.deadLetterWorker) {
      return;
    }
    const queue: string = `${this.options.deadLetterStream}-worker`;
    const streams: readonly string[] = [this.options.eventsStream, this.options.restrictedStream];
    for (const stream of streams) {
      const sources: readonly (readonly [DeadLetterReason, string])[] = [
        ['max-deliveries', maxDeliveriesAdvisorySubject(stream)],
        ['terminated', terminatedAdvisorySubject(stream)],
      ];
      for (const [reason, subject] of sources) {
        const subscription: Subscription = this.connection.nats.subscribe(subject, { queue });
        this.subscriptions.push(subscription);
        this.running.push(this.work(stream, reason, subscription));
      }
    }
    await this.connection.flush();
    this.logger.log({ streams }, 'dead-letter worker started');
  }

  /**
   * Method beforeApplicationShutdown
   *
   * @description
   * Drains the advisory subscriptions, so the advisories already received are copied, and stops
   * waiting between attempts: a copy still failing then gives up with an error log.
   *
   * @returns {Promise<void>} Resolves once the worker stopped.
   */
  public async beforeApplicationShutdown(): Promise<void> {
    this.stop.abort();
    await Promise.allSettled(
      this.subscriptions.map((subscription: Subscription) => subscription.drain()),
    );
    await Promise.allSettled(this.running);
  }

  /**
   * Method work
   *
   * @description
   * Copies the dead letter of each advisory of one subject, one at a time.
   *
   * @param {string} stream - Stream whose advisories the subscription receives.
   * @param {DeadLetterReason} reason - What the advisories of this subject report.
   * @param {Subscription} subscription - Subscription on the advisory subject.
   * @returns {Promise<void>} Resolves when the subscription closed.
   */
  private async work(
    stream: string,
    reason: DeadLetterReason,
    subscription: Subscription,
  ): Promise<void> {
    try {
      for await (const message of subscription as AsyncIterable<Msg>) {
        const advisory: ConsumerAdvisory | undefined = this.parse(stream, message);
        if (advisory !== undefined) {
          await this.copyWithRetries({ reason, advisory });
        }
      }
    } catch (error) {
      this.logger.error({ stream, reason, err: error }, 'dead-letter subscription failed');
    }
  }

  /**
   * Method parse
   *
   * @description
   * Reads the fields of an advisory of the expected stream.
   *
   * @param {string} expectedStream - Stream whose advisories the subscription receives.
   * @param {Msg} message - Advisory published by JetStream.
   * @returns {ConsumerAdvisory | undefined} The fields, or `undefined` for an unreadable advisory, which is logged.
   */
  private parse(expectedStream: string, message: Msg): ConsumerAdvisory | undefined {
    let decoded: unknown;
    try {
      decoded = JSON.parse(message.string());
    } catch {
      decoded = undefined;
    }
    const parsed: z.ZodSafeParseResult<ConsumerAdvisory> = advisorySchema.safeParse(decoded);
    if (!parsed.success || parsed.data.stream !== expectedStream) {
      this.logger.error({ subject: message.subject }, 'unreadable consumer advisory');
      return undefined;
    }
    return parsed.data;
  }

  /**
   * Method copyWithRetries
   *
   * @description
   * Stores a dead letter, trying again after each delay of the worker on failure.
   *
   * @param {DeadLetter} deadLetter - Reason and advisory of the dead letter.
   * @returns {Promise<void>} Resolves once stored, or once every attempt failed, which is logged with the consumer, the stream and the sequence.
   */
  private async copyWithRetries(deadLetter: DeadLetter): Promise<void> {
    const delays: readonly number[] = this.tuning.deadLetterRetryDelaysMs;
    for (let attempt: number = 0; ; attempt += 1) {
      try {
        await this.copy(deadLetter);
        return;
      } catch (error) {
        const delayMs: number | undefined = delays[attempt];
        const fields: Record<string, unknown> = {
          stream: deadLetter.advisory.stream,
          consumer: deadLetter.advisory.consumer,
          streamSequence: deadLetter.advisory.stream_seq,
          reason: deadLetter.reason,
          attempt: attempt + 1,
          errorClass: errorClassOf(error),
        };
        if (delayMs === undefined || this.stop.signal.aborted) {
          this.logger.error({ ...fields, err: error }, 'dead letter could not be copied');
          return;
        }
        this.logger.warn({ ...fields, retryInMs: delayMs }, 'dead letter copy failed: will retry');
        await this.pause(delayMs);
      }
    }
  }

  /**
   * Method pause
   *
   * @description
   * Waits, unless the application stops first.
   *
   * @param {number} delayMs - Pause, in milliseconds.
   * @returns {Promise<void>} Resolves after the pause or on shutdown.
   */
  private async pause(delayMs: number): Promise<void> {
    if (this.stop.signal.aborted) {
      return;
    }
    await new Promise<void>((resolve: () => void) => {
      const timer: NodeJS.Timeout = setTimeout(done, delayMs);
      this.stop.signal.addEventListener('abort', done, { once: true });
      /**
       * Function done
       *
       * @description
       * Ends the pause.
       *
       * @returns {void}
       */
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  /**
   * Method copy
   *
   * @description
   * Reads the message an advisory points at with `$JS.API.STREAM.MSG.GET.<stream>` (never the
   * direct get API, which the streams do not enable) and republishes it on
   * `dlq.<consumer>.<original subject>`, asking the server to store it in the dead-letter stream.
   *
   * @param {DeadLetter} deadLetter - Reason and advisory of the dead letter.
   * @returns {Promise<void>} Resolves once the dead letter is stored, or was found missing.
   */
  private async copy(deadLetter: DeadLetter): Promise<void> {
    const { reason, advisory }: DeadLetter = deadLetter;
    const stream: string = advisory.stream;
    const consumer: string = advisory.consumer;
    const streamSequence: number = advisory.stream_seq;
    const manager: JetStreamManager = await this.connection.manager();
    const original: StoredMsg | null = await manager.streams.getMessage(stream, {
      seq: streamSequence,
    });
    if (original === null) {
      this.logger.error(
        { reason, stream, consumer, streamSequence },
        'dead letter is no longer in the stream: not copied',
      );
      return;
    }
    const deadLetterHeaders: MsgHdrs = headers();
    for (const [key, values] of original.header) {
      if (!NOT_COPIED_HEADER.test(key)) {
        for (const value of values) {
          deadLetterHeaders.append(key, value);
        }
      }
    }
    deadLetterHeaders.set(DEAD_LETTER_CONSUMER_HEADER, consumer);
    deadLetterHeaders.set(DEAD_LETTER_REASON_HEADER, reason);
    deadLetterHeaders.set(DEAD_LETTER_SEQUENCE_HEADER, String(streamSequence));
    if (advisory.deliveries !== undefined) {
      deadLetterHeaders.set(DEAD_LETTER_DELIVERIES_HEADER, String(advisory.deliveries));
    }
    const dropPayload: boolean =
      stream === this.options.restrictedStream &&
      this.options.restrictedDeadLetterPayload === 'drop';
    if (dropPayload) {
      deadLetterHeaders.set(DEAD_LETTER_PAYLOAD_HEADER, 'dropped');
    }
    await this.connection.jetstream.publish(
      deadLetterSubject(this.options.deadLetterSubjectPrefix, consumer, original.subject),
      dropPayload ? new Uint8Array() : original.data,
      {
        msgID: deadLetterMessageId(stream, consumer, streamSequence),
        headers: deadLetterHeaders,
        timeout: this.options.publishTimeoutMs,
        expect: { streamName: this.options.deadLetterStream },
      },
    );
    this.logger.error(
      {
        event: original.header.get(EVENT_NAME_HEADER).slice(0, 200) || undefined,
        stream,
        subject: original.subject,
        consumer,
        streamSequence,
        deliveries: advisory.deliveries,
        reason,
        terminationReason: boundedReason(advisory.reason),
        payloadDropped: dropPayload,
      },
      'dead letter copied',
    );
  }
  // #endregion
}
