import {
  DiscardPolicy,
  JetStreamApiCodes,
  RetentionPolicy,
  StorageType,
  type JetStreamManager,
  type StreamConfig,
} from '@nats-io/jetstream';
import { nanos } from '@nats-io/transport-node';
import type { Logger } from '@nestjs/common';

import {
  DUPLICATE_WINDOW_MS,
  EVENTS_MAX_AGE_DAYS,
  RESTRICTED_MAX_AGE_MS,
} from '../configuration/messaging-defaults.js';
import type { ResolvedMessagingOptions } from '../configuration/messaging-options.js';
import { isJetStreamApiError } from './jetstream-api-error.js';

/**
 * Constant DAY_MS
 *
 * @description
 * Number of milliseconds used to convert stream retention from days.
 *
 * @type {number}
 */
const DAY_MS: number = 86_400_000;

/**
 * Interface ManagedStream
 *
 * @description
 * Identifies a stream and its storage limits when Messaging manages JetStream resources.
 */
interface ManagedStream {
  // #region Properties
  /**
   * Property name
   *
   * @description
   * Stream name.
   *
   * @type {string}
   * @readonly
   */
  readonly name: string;

  /**
   * Property subject
   *
   * @description
   * Wildcard subject stored by the stream.
   *
   * @type {string}
   * @readonly
   */
  readonly subject: string;

  /**
   * Property maxAgeMs
   *
   * @description
   * Retention duration in milliseconds.
   *
   * @type {number}
   * @readonly
   */
  readonly maxAgeMs: number;

  /**
   * Property maxBytes
   *
   * @description
   * Stream byte limit, or -1 for unlimited.
   *
   * @type {number}
   * @readonly
   */
  readonly maxBytes: number;
  // #endregion
}

/**
 * Function prepareStreams
 *
 * @description
 * Checks the streams this service uses, or provisions all three for a managed installation.
 *
 * @param {JetStreamManager} manager - Administrative client on the application's connection.
 * @param {ResolvedMessagingOptions} options - Stream names, subjects and limits.
 * @param {Logger} logger - Logger for streams created during startup.
 * @returns {Promise<void>} Resolves when the streams are ready.
 */
export async function prepareStreams(
  manager: JetStreamManager,
  options: ResolvedMessagingOptions,
  logger: Logger,
): Promise<void> {
  if (!options.manageStreams) {
    await checkStreams(manager, options);
    return;
  }

  const managed: readonly ManagedStream[] = [
    {
      name: options.eventsStream,
      subject: `${options.eventSubjectPrefix}.>`,
      maxAgeMs: EVENTS_MAX_AGE_DAYS * DAY_MS,
      maxBytes: options.eventsMaxBytes,
    },
    {
      name: options.restrictedStream,
      subject: `${options.restrictedSubjectPrefix}.>`,
      maxAgeMs: RESTRICTED_MAX_AGE_MS,
      maxBytes: options.restrictedMaxBytes,
    },
    {
      name: options.deadLetterStream,
      subject: `${options.deadLetterSubjectPrefix}.>`,
      maxAgeMs: options.deadLetterMaxAgeDays * DAY_MS,
      maxBytes: options.deadLetterMaxBytes,
    },
  ];
  for (const stream of managed) {
    await ensureStream(manager, stream, logger);
  }
}

/**
 * Function checkStreams
 *
 * @description
 * Checks only the streams required by the enabled capabilities and reports all missing ones together.
 *
 * @param {JetStreamManager} manager - JetStream client with permission to inspect the configured streams.
 * @param {ResolvedMessagingOptions} options - Enabled capabilities and the names of their streams.
 * @returns {Promise<void>} Resolves when the streams required by the configured capabilities exist.
 */
async function checkStreams(
  manager: JetStreamManager,
  options: ResolvedMessagingOptions,
): Promise<void> {
  const used: string[] = [options.eventsStream];
  if (options.restrictedEvents.length > 0 || options.deadLetterWorker) {
    used.push(options.restrictedStream);
  }
  if (options.deadLetterWorker) {
    used.push(options.deadLetterStream);
  }

  const missing: string[] = [];
  for (const stream of used) {
    if (!(await streamExists(manager, stream))) {
      missing.push(stream);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `The stream ${missing.join(', ')} does not exist: the streams are created by cadenway-ops, or by MessagingModule with manageStreams in local tests.`,
    );
  }
}

/**
 * Function streamExists
 *
 * @description
 * Checks stream existence without treating broker or permission failures as a missing stream.
 *
 * @param {JetStreamManager} manager - JetStream client used to inspect the stream.
 * @param {string} stream - Name of the stream to check.
 * @returns {Promise<boolean>} Resolves to whether the named stream exists. Other JetStream errors are propagated.
 */
async function streamExists(manager: JetStreamManager, stream: string): Promise<boolean> {
  try {
    await manager.streams.info(stream);
    return true;
  } catch (error) {
    if (isJetStreamApiError(error, JetStreamApiCodes.StreamNotFound)) {
      return false;
    }
    throw error;
  }
}

/**
 * Function ensureStream
 *
 * @description
 * Updates the configured limits of an existing stream or provisions it with file storage and oldest-first discard.
 *
 * @param {JetStreamManager} manager - JetStream client with permission to create or update streams.
 * @param {ManagedStream} stream - Subject, age and byte limits to apply.
 * @param {Logger} logger - Logger for stream creation.
 * @returns {Promise<void>} Resolves once the stream has the requested configuration.
 */
async function ensureStream(
  manager: JetStreamManager,
  stream: ManagedStream,
  logger: Logger,
): Promise<void> {
  const limits: Pick<StreamConfig, 'subjects' | 'max_age' | 'max_bytes' | 'duplicate_window'> = {
    subjects: [stream.subject],
    max_age: nanos(stream.maxAgeMs),
    max_bytes: stream.maxBytes,
    duplicate_window: nanos(DUPLICATE_WINDOW_MS),
  };
  if (await streamExists(manager, stream.name)) {
    await manager.streams.update(stream.name, limits);
    return;
  }
  await manager.streams.add({
    name: stream.name,
    storage: StorageType.File,
    retention: RetentionPolicy.Limits,
    discard: DiscardPolicy.Old,
    ...limits,
  });
  logger.log({ stream: stream.name, subject: stream.subject }, 'stream created');
}
