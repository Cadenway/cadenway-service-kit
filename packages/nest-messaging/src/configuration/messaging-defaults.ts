/**
 * Constant DEFAULT_EVENTS_STREAM
 *
 * @description
 * Name of the stream that stores the events.
 *
 * @type {string}
 */
export const DEFAULT_EVENTS_STREAM: string = 'EVENTS';

/**
 * Constant DEFAULT_RESTRICTED_STREAM
 *
 * @description
 * Name of the stream that stores the restricted events: the identity events that carry a
 * single-use code or link, which only notification-service may read.
 *
 * @type {string}
 */
export const DEFAULT_RESTRICTED_STREAM: string = 'EVENTS_RESTRICTED';

/**
 * Constant DEFAULT_DEAD_LETTER_STREAM
 *
 * @description
 * Name of the stream that stores the dead letters.
 *
 * @type {string}
 */
export const DEFAULT_DEAD_LETTER_STREAM: string = 'EVENTS_DLQ';

/**
 * Constant DEFAULT_EVENT_SUBJECT_PREFIX
 *
 * @description
 * First token of the subject of an event.
 *
 * @type {string}
 */
export const DEFAULT_EVENT_SUBJECT_PREFIX: string = 'evt';

/**
 * Constant DEFAULT_RESTRICTED_SUBJECT_PREFIX
 *
 * @description
 * First token of the subject of a restricted event.
 *
 * @type {string}
 */
export const DEFAULT_RESTRICTED_SUBJECT_PREFIX: string = 'restricted';

/**
 * Constant DEFAULT_DEAD_LETTER_SUBJECT_PREFIX
 *
 * @description
 * First token of the subject of a dead letter.
 *
 * @type {string}
 */
export const DEFAULT_DEAD_LETTER_SUBJECT_PREFIX: string = 'dlq';

/**
 * Constant DEFAULT_REBUILD_SUBJECT_PREFIX
 *
 * @description
 * First token of the subject of a rebuild item.
 *
 * @type {string}
 */
export const DEFAULT_REBUILD_SUBJECT_PREFIX: string = 'rebuild';

/**
 * Constant EVENTS_MAX_AGE_DAYS
 *
 * @description
 * How long the events stream keeps a message, in days, when the module manages the streams: seven,
 * as cadenway-ops.
 *
 * @type {number}
 */
export const EVENTS_MAX_AGE_DAYS: number = 7;

/**
 * Constant RESTRICTED_MAX_AGE_MS
 *
 * @description
 * How long the restricted stream keeps a message, in milliseconds, when the module manages the
 * streams: one hour, as cadenway-ops (`compose/nats/ensure-streams.sh`). Its messages carry a
 * single-use code or link, which should not stay stored longer than it is useful.
 *
 * @type {number}
 */
export const RESTRICTED_MAX_AGE_MS: number = 3_600_000;

/**
 * Constant DUPLICATE_WINDOW_MS
 *
 * @description
 * How long the server remembers a `Nats-Msg-Id`, in milliseconds, when the module manages the
 * streams: two minutes. Past that window only the processed-ids table of a consumer protects it.
 *
 * @type {number}
 */
export const DUPLICATE_WINDOW_MS: number = 120_000;

/**
 * Constant ACK_WAIT_MS
 *
 * @description
 * How long a consumer may hold a message before the server redelivers it, in milliseconds.
 *
 * @type {number}
 */
export const ACK_WAIT_MS: number = 30_000;

/**
 * Constant DEFAULT_EVENTS_MAX_BYTES
 *
 * @description
 * Byte cap of the events stream when the module manages the streams: 1 GiB, as cadenway-ops.
 *
 * @type {number}
 */
export const DEFAULT_EVENTS_MAX_BYTES: number = 1_073_741_824;

/**
 * Constant DEFAULT_RESTRICTED_MAX_BYTES
 *
 * @description
 * Byte cap of the restricted stream when the module manages the streams: 64 MiB, as
 * cadenway-ops.
 *
 * @type {number}
 */
export const DEFAULT_RESTRICTED_MAX_BYTES: number = 67_108_864;

/**
 * Constant DEFAULT_DEAD_LETTER_MAX_BYTES
 *
 * @description
 * Byte cap of the dead-letter stream when the module manages the streams: 256 MiB, as
 * cadenway-ops.
 *
 * @type {number}
 */
export const DEFAULT_DEAD_LETTER_MAX_BYTES: number = 268_435_456;

/**
 * Constant DEFAULT_DEAD_LETTER_MAX_AGE_DAYS
 *
 * @description
 * How long the dead-letter stream keeps a message, in days, when the module manages the streams.
 *
 * @type {number}
 */
export const DEFAULT_DEAD_LETTER_MAX_AGE_DAYS: number = 30;

/**
 * Constant DEFAULT_PUBLISH_TIMEOUT_MS
 *
 * @description
 * How long a publish waits for the JetStream acknowledgement, in milliseconds.
 *
 * @type {number}
 */
export const DEFAULT_PUBLISH_TIMEOUT_MS: number = 5000;

/**
 * Constant DEFAULT_SHUTDOWN_TIMEOUT_MS
 *
 * @description
 * How long a shutdown waits for the running handlers, in milliseconds.
 *
 * @type {number}
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS: number = 10_000;

/**
 * Constant DEFAULT_REBUILD_TIMEOUT_MS
 *
 * @description
 * How long a rebuild emitter waits for the consumer to acknowledge one item, in milliseconds,
 * when rebuild items are acknowledged.
 *
 * @type {number}
 */
export const DEFAULT_REBUILD_TIMEOUT_MS: number = 30_000;

/**
 * Constant DEFAULT_HANDLER_TIMEOUT_MS
 *
 * @description
 * Time an event handler may take before its attempt is abandoned, in milliseconds: 25 seconds,
 * below the 30 seconds after which the server redelivers the message.
 *
 * @type {number}
 */
export const DEFAULT_HANDLER_TIMEOUT_MS: number = 25_000;

/**
 * Constant DEFAULT_REBUILD_MAX_PENDING
 *
 * @description
 * Number of rebuild items that may wait at the consumer of one entity before the next ones are
 * dropped.
 *
 * @type {number}
 */
export const DEFAULT_REBUILD_MAX_PENDING: number = 1000;

/**
 * Constant DEFAULT_REBUILD_FLUSH_EVERY
 *
 * @description
 * Number of rebuild items sent between two flushes when rebuild items are not acknowledged.
 *
 * @type {number}
 */
export const DEFAULT_REBUILD_FLUSH_EVERY: number = 100;
