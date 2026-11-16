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
import { errorCategoryOf } from '../observability/error-class.js';
import {
  MESSAGING_OPTIONS,
  type ResolvedMessagingOptions,
} from '../configuration/messaging-options.js';
import { MESSAGING_TUNING, type MessagingTuning } from '../configuration/messaging-tuning.js';
import { waitForRetry } from '../retry/wait-for-retry.js';
import {
  DEAD_LETTER_CONSUMER_HEADER,
  DEAD_LETTER_DELIVERIES_HEADER,
  DEAD_LETTER_PAYLOAD_HEADER,
  DEAD_LETTER_REASON_HEADER,
  DEAD_LETTER_SEQUENCE_HEADER,
  EVENT_NAME_HEADER,
} from '../transport/event-headers.js';
import {
  deadLetterMessageId,
  deadLetterSubject,
  maxDeliveriesAdvisorySubject,
  terminatedAdvisorySubject,
} from '../transport/subjects.js';

/**
 * Type DeadLetterReason
 *
 * @description
 * Whether a consumer exhausted its delivery attempts or terminated the message.
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
 * Function loggedTerminationReason
 *
 * @description
 * Preserves the kit's termination reasons and classifies external reasons without logging them.
 *
 * @param {string | undefined} reason - Reason recorded by the terminating consumer, if any.
 * @returns {string | undefined} A kit reason, a fixed label for an external reason, or undefined when none was supplied.
 */
export function loggedTerminationReason(reason: string | undefined): string | undefined {
  if (reason === undefined || KNOWN_TERMINATION_REASONS.has(reason)) {
    return reason;
  }
  return 'external-termination';
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
 * Constant MAX_PENDING_ADVISORIES
 *
 * @description
 * Maximum number of advisories waiting behind an active copy on one subscription.
 *
 * @type {number}
 */
const MAX_PENDING_ADVISORIES: number = 1_000;
/**
 * Constant MAX_PENDING_BYTES
 *
 * @description
 * Maximum aggregate size of advisory payloads waiting on one subscription, in bytes.
 *
 * @type {number}
 */
const MAX_PENDING_BYTES: number = 16 * 1024 * 1024;
/**
 * Constant decoder
 *
 * @description
 * Decodes advisory payloads as UTF-8 before interpreting their JSON.
 *
 * @type {TextDecoder}
 */
const decoder: TextDecoder = new TextDecoder();

/**
 * Interface AdvisorySource
 *
 * @description
 * Tracks pending advisories and the serial copy loop of one subscription.
 */
interface AdvisorySource {
  // #region Properties
  /**
   * Property stream
   *
   * @description
   * Stream whose messages are eligible for the copy.
   *
   * @type {string}
   * @readonly
   */
  readonly stream: string;

  /**
   * Property reason
   *
   * @description
   * Why JetStream emitted the advisory.
   *
   * @type {DeadLetterReason}
   * @readonly
   */
  readonly reason: DeadLetterReason;

  /**
   * Property subject
   *
   * @description
   * Subject used when reporting the subscription's health.
   *
   * @type {string}
   * @readonly
   */
  readonly subject: string;

  /**
   * Property pending
   *
   * @description
   * Detached payloads waiting for the active copy to finish.
   *
   * @type {Uint8Array[]}
   * @readonly
   */
  readonly pending: Uint8Array[];

  /**
   * Property pendingBytes
   *
   * @description
   * Total size of the queued payloads in bytes.
   *
   * @type {number}
   */
  pendingBytes: number;

  /**
   * Property dropped
   *
   * @description
   * Number of arrivals refused since subscription.
   *
   * @type {number}
   */
  dropped: number;

  /**
   * Property active
   *
   * @description
   * Completion of the current copy loop, if active.
   *
   * @type {Promise<void> | undefined}
   */
  active: Promise<void> | undefined;
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
 * messages and may be lost while no worker is connected or an admission limit is reached.
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
   * Property sources
   *
   * @description
   * One bounded intake queue per advisory subject.
   *
   * @type {AdvisorySource[]}
   * @readonly
   */
  private readonly sources: AdvisorySource[] = [];

  /**
   * Property stop
   *
   * @description
   * Aborted on shutdown to stop admission and cancel waits for another attempt.
   *
   * @type {AbortController}
   * @readonly
   */
  private readonly stop: AbortController = new AbortController();

  /**
   * Property abandon
   *
   * @description
   * Aborted when the grace period for active copies expires.
   *
   * @type {AbortController}
   * @readonly
   */
  private readonly abandon: AbortController = new AbortController();
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
        const source: AdvisorySource = {
          stream,
          reason,
          subject,
          pending: [],
          pendingBytes: 0,
          dropped: 0,
          active: undefined,
        };
        // A callback bypasses the NATS iterator's unbounded message buffer.
        const subscription: Subscription = this.connection.nats.subscribe(subject, {
          queue,
          callback: (error: Error | null, message: Msg): void => {
            if (error !== null) {
              this.logger.error(
                { stream, reason, errorClass: errorCategoryOf(error) },
                'dead-letter subscription failed',
              );
              return;
            }
            this.accept(source, message.data);
          },
        });
        this.subscriptions.push(subscription);
        this.sources.push(source);
      }
    }
    await this.connection.flush();
    this.logger.log({ streams }, 'dead-letter worker started');
  }

  /**
   * Method beforeApplicationShutdown
   *
   * @description
   * Stops intake and retries, drops queued advisories and lets active copies finish within
   * the shutdown budget. The connection's later shutdown hook owns the final drain.
   *
   * @returns {Promise<void>} Resolves once the worker stopped.
   */
  public async beforeApplicationShutdown(): Promise<void> {
    this.stop.abort();
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
    const running: Promise<void>[] = [];
    for (const source of this.sources) {
      source.pending.length = 0;
      source.pendingBytes = 0;
      if (source.active !== undefined) {
        running.push(source.active);
      }
    }
    if (running.length === 0) {
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, this.options.shutdownTimeoutMs);
    });
    try {
      const outcome: 'stopped' | 'timeout' = await Promise.race([
        Promise.allSettled(running).then((): 'stopped' => 'stopped'),
        deadline,
      ]);
      if (outcome === 'timeout') {
        this.abandon.abort();
        this.logger.warn(
          { timeoutMs: this.options.shutdownTimeoutMs },
          'dead-letter copies still running at shutdown were abandoned',
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Method accept
   *
   * @description
   * Reserves space synchronously so overload cannot accumulate in the NATS callback.
   *
   * @param {AdvisorySource} source - Queue and budget associated with the advisory subscription.
   * @param {Uint8Array} data - Wire payload used to enforce the byte budget before copying data.
   */
  private accept(source: AdvisorySource, data: Uint8Array): void {
    if (this.stop.signal.aborted) {
      return;
    }
    if (
      source.pending.length >= MAX_PENDING_ADVISORIES ||
      source.pendingBytes + data.byteLength > MAX_PENDING_BYTES
    ) {
      source.dropped += 1;
      if (source.dropped === 1 || source.dropped % MAX_PENDING_ADVISORIES === 0) {
        this.logger.warn(
          { subject: source.subject, dropped: source.dropped },
          'dead-letter advisory queue is full: dropped',
        );
      }
      return;
    }
    source.pending.push(new Uint8Array(data));
    source.pendingBytes += data.byteLength;
    source.active ??= Promise.resolve().then(() => this.work(source));
  }

  /**
   * Method work
   *
   * @description
   * Copies each accepted advisory in delivery order, with at most one active copy per subject.
   *
   * @param {AdvisorySource} source - Subscription queue and metadata for the copies it schedules.
   * @returns {Promise<void>} Resolves when the queue drains or shutdown stops admission.
   */
  private async work(source: AdvisorySource): Promise<void> {
    try {
      while (!this.stop.signal.aborted) {
        const data: Uint8Array | undefined = source.pending.shift();
        if (data === undefined) {
          return;
        }
        source.pendingBytes -= data.byteLength;
        const advisory: ConsumerAdvisory | undefined = this.parse(source, data);
        if (advisory !== undefined) {
          await this.copyWithRetries({ reason: source.reason, advisory });
        }
      }
    } catch (error) {
      this.logger.error(
        { subject: source.subject, errorClass: errorCategoryOf(error) },
        'dead-letter copy loop failed',
      );
    } finally {
      source.active = undefined;
    }
  }

  /**
   * Method parse
   *
   * @description
   * Reads the required fields of an advisory and verifies it came from the expected stream.
   *
   * @param {AdvisorySource} source - Subscription whose stream the advisory must reference.
   * @param {Uint8Array} data - UTF-8 JSON advisory payload.
   * @returns {ConsumerAdvisory | undefined} Validated metadata or undefined when the advisory is malformed or refers to another stream.
   */
  private parse(source: AdvisorySource, data: Uint8Array): ConsumerAdvisory | undefined {
    let decoded: unknown;
    try {
      decoded = JSON.parse(decoder.decode(data));
    } catch {
      decoded = undefined;
    }
    const parsed: z.ZodSafeParseResult<ConsumerAdvisory> = advisorySchema.safeParse(decoded);
    if (!parsed.success || parsed.data.stream !== source.stream) {
      this.logger.error({ subject: source.subject }, 'unreadable consumer advisory');
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
          errorClass: errorCategoryOf(error),
        };
        if (delayMs !== undefined && !this.stop.signal.aborted) {
          this.logger.warn(
            { ...fields, retryInMs: delayMs },
            'dead letter copy failed: will retry',
          );
          await waitForRetry(delayMs, this.stop.signal);
        }
        if (delayMs === undefined || this.stop.signal.aborted) {
          this.logger.error(fields, 'dead letter could not be copied');
          return;
        }
      }
    }
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
    this.abandon.signal.throwIfAborted();
    const original: StoredMsg | null = await manager.streams.getMessage(stream, {
      seq: streamSequence,
    });
    this.abandon.signal.throwIfAborted();
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
        terminationReason: loggedTerminationReason(advisory.reason),
        payloadDropped: dropPayload,
      },
      'dead letter copied',
    );
  }
  // #endregion
}
