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

const DAY_MS: number = 86_400_000;

interface ManagedStream {
  // #region Properties
  /** Stream name. */
  readonly name: string;

  /** Wildcard subject stored by the stream. */
  readonly subject: string;

  /** Retention duration in milliseconds. */
  readonly maxAgeMs: number;

  /** Stream byte limit, or -1 for unlimited. */
  readonly maxBytes: number;
  // #endregion
}

/**
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
