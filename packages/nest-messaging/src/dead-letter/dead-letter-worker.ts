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
import { MESSAGING_OPTIONS, type ResolvedMessagingOptions } from '../messaging-options.js';
import {
  DEAD_LETTER_CONSUMER_HEADER,
  DEAD_LETTER_DELIVERIES_HEADER,
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
 * Class DeadLetterWorker
 *
 * @description
 * Copies dead letters into the dead-letter stream. JetStream has no dead-letter queue: when a
 * consumer of the events stream or of the restricted stream reaches its delivery limit or
 * terminates a message, the server publishes an advisory, and this worker reads the original
 * message from its stream by sequence and republishes it on `dlq.<consumer>.<original subject>`
 * with the original headers plus the consumer, the reason, the sequence and the delivery count.
 *
 * The worker runs only when `deadLetterWorker` is on, in notification-service only: reading a
 * message by sequence includes the restricted ones, which no other service may see. Its
 * replicas share the advisories through a queue group, and the `Nats-Msg-Id` of a dead
 * letter is derived from the consumer and the sequence, so an advisory seen twice is stored
 * once. Advisories are plain NATS messages: one published while no worker is connected is
 * lost, and the message then stays in the events stream until it expires.
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
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Stores the connection and the options.
   *
   * @param {MessagingConnection} connection - NATS connection of the application.
   * @param {ResolvedMessagingOptions} options - Options of the module.
   * @constructor
   */
  public constructor(
    private readonly connection: MessagingConnection,
    @Inject(MESSAGING_OPTIONS) private readonly options: ResolvedMessagingOptions,
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
   * Stops receiving advisories and lets the copy in progress finish.
   *
   * @returns {Promise<void>} Resolves once the worker stopped.
   */
  public async beforeApplicationShutdown(): Promise<void> {
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
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
      for await (const advisory of subscription as AsyncIterable<Msg>) {
        try {
          await this.copy(stream, reason, advisory);
        } catch (error) {
          this.logger.error({ stream, reason, err: error }, 'dead letter could not be copied');
        }
      }
    } catch (error) {
      this.logger.error({ stream, reason, err: error }, 'dead-letter subscription failed');
    }
  }

  /**
   * Method copy
   *
   * @description
   * Reads the message an advisory points at with `$JS.API.STREAM.MSG.GET.<stream>` (never the
   * direct get API, which the streams do not enable) and republishes it on
   * `dlq.<consumer>.<original subject>`.
   *
   * @param {string} expectedStream - Stream whose advisories the subscription receives.
   * @param {DeadLetterReason} reason - Why the message is a dead letter.
   * @param {Msg} advisory - Advisory published by JetStream.
   * @returns {Promise<void>} Resolves once the dead letter is stored, or was found missing.
   */
  private async copy(
    expectedStream: string,
    reason: DeadLetterReason,
    advisory: Msg,
  ): Promise<void> {
    const parsed: z.ZodSafeParseResult<ConsumerAdvisory> = advisorySchema.safeParse(
      JSON.parse(advisory.string()),
    );
    if (!parsed.success || parsed.data.stream !== expectedStream) {
      this.logger.error({ reason, subject: advisory.subject }, 'unreadable consumer advisory');
      return;
    }
    const stream: string = parsed.data.stream;
    const consumer: string = parsed.data.consumer;
    const streamSequence: number = parsed.data.stream_seq;
    const manager: JetStreamManager = await this.connection.manager();
    const original: StoredMsg | null = await manager.streams.getMessage(stream, {
      seq: streamSequence,
    });
    if (original === null) {
      this.logger.error(
        { reason, consumer, streamSequence },
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
    if (parsed.data.deliveries !== undefined) {
      deadLetterHeaders.set(DEAD_LETTER_DELIVERIES_HEADER, String(parsed.data.deliveries));
    }
    await this.connection.jetstream.publish(
      deadLetterSubject(this.options.deadLetterSubjectPrefix, consumer, original.subject),
      original.data,
      {
        msgID: deadLetterMessageId(stream, consumer, streamSequence),
        headers: deadLetterHeaders,
        timeout: this.options.publishTimeoutMs,
      },
    );
    this.logger.error(
      {
        event: original.header.get(EVENT_NAME_HEADER) || undefined,
        stream,
        subject: original.subject,
        consumer,
        streamSequence,
        deliveries: parsed.data.deliveries,
        reason,
        terminationReason: parsed.data.reason,
      },
      'dead letter copied',
    );
  }
  // #endregion
}
