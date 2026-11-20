import type { ConsumerInfo, JetStreamManager, StreamInfo } from '@nats-io/jetstream';

import type { EventTarget } from './event-target.js';

/**
 * Interface EventConsumerProgress
 *
 * @description
 * Broker metadata for one registered durable. The two sequence numbers use stream coordinates.
 */
export interface EventConsumerProgress {
  // #region Properties
  /**
   * Property handler
   *
   * @description
   * Registered handler name without the service prefix.
   *
   * @type {string}
   * @readonly
   */
  readonly handler: string;

  /**
   * Property createdAt
   *
   * @description
   * Broker creation timestamp of this durable, preserving its full precision for identity checks.
   *
   * @type {string}
   * @readonly
   */
  readonly createdAt: string;

  /**
   * Property deliveredSequence
   *
   * @description
   * Broker-reported delivery position in the stream.
   *
   * @type {number}
   * @readonly
   */
  readonly deliveredSequence: number;

  /**
   * Property ackFloorSequence
   *
   * @description
   * Broker-reported acknowledgement floor in the stream.
   *
   * @type {number}
   * @readonly
   */
  readonly ackFloorSequence: number;

  /**
   * Property pending
   *
   * @description
   * Number of matching messages waiting for their first delivery.
   *
   * @type {number}
   * @readonly
   */
  readonly pending: number;

  /**
   * Property ackPending
   *
   * @description
   * Number of deliveries awaiting acknowledgement.
   *
   * @type {number}
   * @readonly
   */
  readonly ackPending: number;
  // #endregion
}

/**
 * Interface EventStreamProgress
 *
 * @description
 * A bounded observation of the configured event stream and its registered durables.
 */
export interface EventStreamProgress {
  // #region Properties
  /**
   * Property stream
   *
   * @description
   * Configured name of the ordinary event stream.
   *
   * @type {string}
   * @readonly
   */
  readonly stream: string;

  /**
   * Property createdAt
   *
   * @description
   * Broker creation timestamp of the stream, preserving its full precision for identity checks.
   *
   * @type {string}
   * @readonly
   */
  readonly createdAt: string;

  /**
   * Property firstSequence
   *
   * @description
   * Retention floor reported by the broker after reading the durables.
   *
   * @type {number}
   * @readonly
   */
  readonly firstSequence: number;

  /**
   * Property lastSequence
   *
   * @description
   * Highest sequence assigned by the broker before reading the durables.
   *
   * @type {number}
   * @readonly
   */
  readonly lastSequence: number;

  /**
   * Property retainedGapCount
   *
   * @description
   * Number of deleted positions reported within the stream's retained range.
   *
   * @type {number}
   * @readonly
   */
  readonly retainedGapCount: number;

  /**
   * Property consumers
   *
   * @description
   * One observation per distinct handler in the order first requested.
   *
   * @type {readonly EventConsumerProgress[]}
   * @readonly
   */
  readonly consumers: readonly EventConsumerProgress[];
  // #endregion
}

/**
 * Function isCreationTime
 *
 * @description
 * Checks that a broker identity contains a real timestamp without truncating fractional seconds.
 *
 * @param {string} created - Raw creation timestamp from JetStream.
 * @returns {boolean} Whether the value can identify a stream or durable generation.
 */
function isCreationTime(created: string): boolean {
  return (
    typeof created === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(created) &&
    Number.isFinite(Date.parse(created))
  );
}

/**
 * Function isSequence
 *
 * @description
 * Keeps broker numbers lossless when they cross the public JavaScript interface.
 *
 * @param {number} count - A stream position or message count.
 * @returns {boolean} Whether the broker value is a nonnegative safe integer.
 */
function isSequence(count: number): boolean {
  return Number.isSafeInteger(count) && count >= 0;
}

/**
 * Function readGapCount
 *
 * @description
 * Applies JetStream's wire default when the broker omits a zero deletion count.
 *
 * @param {{ readonly num_deleted?: number }} state - Stream state as returned by the broker.
 * @returns {number} The reported gap count or zero if the field is absent.
 */
function readGapCount(state: { readonly num_deleted?: number }): number {
  const { num_deleted: count = 0 } = state;
  return count;
}

/**
 * Function isStreamInfo
 *
 * @description
 * Verifies that the expected stream has a usable identity and retention window.
 *
 * @param {StreamInfo} info - Stream metadata response from JetStream.
 * @param {string} stream - Configured name of the event stream.
 * @returns {boolean} Whether the metadata is safe to compare.
 */
function isStreamInfo(info: StreamInfo, stream: string): boolean {
  const { first_seq, last_seq } = info.state;
  const gapCount: number = readGapCount(info.state);
  return (
    info.config.name === stream &&
    isCreationTime(info.created) &&
    isSequence(first_seq) &&
    isSequence(last_seq) &&
    first_seq - 1 <= last_seq &&
    isSequence(gapCount) &&
    gapCount - 1 <= last_seq - first_seq
  );
}

/**
 * Function readEventStreamProgress
 *
 * @description
 * Samples only the configured events stream and the selected local durables. The second stream
 * read rejects a recreated stream and catches a retention floor that has passed the sample.
 *
 * @param {JetStreamManager} manager - Internal manager using the connection's request deadline.
 * @param {string} stream - Configured events stream name.
 * @param {ReadonlyMap<string, EventTarget>} targets - Locally registered targets by handler name.
 * @param {AbortSignal} signal - Cancellation for the remaining reads.
 * @returns {Promise<EventStreamProgress | undefined>} Verified metadata when the sample is usable.
 * @internal
 */
export async function readEventStreamProgress(
  manager: JetStreamManager,
  stream: string,
  targets: ReadonlyMap<string, EventTarget>,
  signal: AbortSignal,
): Promise<EventStreamProgress | undefined> {
  if ([...targets.values()].some(({ route }) => route.restricted || route.stream !== stream)) {
    return undefined;
  }
  const before: StreamInfo = await manager.streams.info(stream);
  signal.throwIfAborted();
  if (!isStreamInfo(before, stream)) {
    return undefined;
  }
  const consumers: (EventConsumerProgress | undefined)[] = await Promise.all(
    [...targets].map(async ([handler, target]): Promise<EventConsumerProgress | undefined> => {
      const info: ConsumerInfo = await manager.consumers.info(stream, target.consumer);
      const deliveredSequence: number = info.delivered.stream_seq;
      const ackFloorSequence: number = info.ack_floor.stream_seq;
      if (
        info.name !== target.consumer ||
        info.stream_name !== stream ||
        info.config.filter_subject !== target.route.subject ||
        !isCreationTime(info.created) ||
        ![deliveredSequence, ackFloorSequence, info.num_pending, info.num_ack_pending].every(
          isSequence,
        ) ||
        ackFloorSequence > deliveredSequence
      ) {
        return undefined;
      }
      return {
        handler,
        createdAt: info.created,
        deliveredSequence,
        ackFloorSequence,
        pending: info.num_pending,
        ackPending: info.num_ack_pending,
      };
    }),
  );
  signal.throwIfAborted();
  if (!consumers.every((consumer) => consumer !== undefined)) {
    return undefined;
  }
  const after: StreamInfo = await manager.streams.info(stream);
  const { first_seq: firstSequence, last_seq: finalSequence } = after.state;
  const lastSequence: number = before.state.last_seq;
  const retainedGapCount: number = readGapCount(after.state);
  if (
    !isStreamInfo(after, stream) ||
    before.created !== after.created ||
    firstSequence < before.state.first_seq ||
    finalSequence < lastSequence ||
    firstSequence - 1 > lastSequence ||
    readGapCount(before.state) !== retainedGapCount ||
    consumers.some((consumer) => consumer.deliveredSequence > finalSequence)
  ) {
    return undefined;
  }
  return {
    stream,
    createdAt: before.created,
    firstSequence,
    lastSequence,
    retainedGapCount,
    consumers,
  };
}
