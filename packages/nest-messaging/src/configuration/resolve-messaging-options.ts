import { eventSubject } from '../transport/subjects.js';
import {
  ACK_WAIT_MS,
  DEFAULT_DEAD_LETTER_MAX_AGE_DAYS,
  DEFAULT_DEAD_LETTER_MAX_BYTES,
  DEFAULT_DEAD_LETTER_STREAM,
  DEFAULT_DEAD_LETTER_SUBJECT_PREFIX,
  DEFAULT_EVENTS_MAX_BYTES,
  DEFAULT_EVENTS_STREAM,
  DEFAULT_EVENT_SUBJECT_PREFIX,
  DEFAULT_HANDLER_TIMEOUT_MS,
  DEFAULT_PUBLISH_TIMEOUT_MS,
  DEFAULT_REBUILD_FLUSH_EVERY,
  DEFAULT_REBUILD_MAX_PENDING,
  DEFAULT_REBUILD_SUBJECT_PREFIX,
  DEFAULT_REBUILD_TIMEOUT_MS,
  DEFAULT_RESTRICTED_MAX_BYTES,
  DEFAULT_RESTRICTED_STREAM,
  DEFAULT_RESTRICTED_SUBJECT_PREFIX,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
} from './messaging-defaults.js';
import type { MessagingModuleOptions, ResolvedMessagingOptions } from './messaging-options.js';

/**
 * Constant NAME_PATTERN
 *
 * @description
 * Shape of a service name and of a rebuild name: one subject token.
 *
 * @type {RegExp}
 */
const NAME_PATTERN: RegExp = /^[A-Za-z0-9_-]+$/u;

/**
 * Constant MAX_TIMER_MS
 *
 * @description
 * Largest whole millisecond delay supported by Node.js timers.
 *
 * @type {number}
 */
const MAX_TIMER_MS: number = 2_147_483_647;

/**
 * Function timerDelay
 *
 * @description
 * Rejects values Node's timers would truncate or reduce to a one-millisecond delay.
 *
 * @param {string} name - Configuration option used to identify an invalid delay.
 * @param {number} value - Candidate whole millisecond delay.
 * @returns {number} The original delay when it is supported by Node.js timers.
 */
function timerDelay(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new Error(
      `The ${name} of MessagingModule must be an integer between 1 and ${String(MAX_TIMER_MS)} ms.`,
    );
  }
  return value;
}

/**
 * Function parseServers
 *
 * @description
 * Turns the `servers` option into a list: a string is split on commas.
 *
 * @param {string | readonly string[]} servers - One URL, several separated by commas, or a list.
 * @returns {readonly string[]} The server URLs.
 * @throws {Error} When no server is left.
 */
export function parseServers(servers: string | readonly string[]): readonly string[] {
  const entries: readonly string[] = typeof servers === 'string' ? servers.split(',') : servers;
  const list: string[] = entries
    .map((entry: string) => entry.trim())
    .filter((entry: string) => entry !== '');
  if (list.length === 0) {
    throw new Error('MessagingModule needs at least one NATS server.');
  }
  return list;
}

/**
 * Function resolveMessagingOptions
 *
 * @description
 * Applies the documented default of every option left unset.
 *
 * @param {MessagingModuleOptions} options - Options given to `MessagingModule`.
 * @returns {ResolvedMessagingOptions} The complete options.
 * @throws {Error} When a name, subject, server, count or timeout is invalid.
 */
export function resolveMessagingOptions(options: MessagingModuleOptions): ResolvedMessagingOptions {
  if (!NAME_PATTERN.test(options.service)) {
    throw new Error(
      'MessagingModule needs a service name made of letters, digits, hyphens and underscores.',
    );
  }
  const rebuildName: string = options.rebuildName ?? options.user ?? options.service;
  if (!NAME_PATTERN.test(rebuildName)) {
    throw new Error(
      'The rebuild name of MessagingModule is made of letters, digits, hyphens and underscores.',
    );
  }
  const rebuildFlushEvery: number = options.rebuildFlushEvery ?? DEFAULT_REBUILD_FLUSH_EVERY;
  const rebuildMaxPending: number = options.rebuildMaxPending ?? DEFAULT_REBUILD_MAX_PENDING;
  for (const [label, count] of [
    ['rebuild flush count', rebuildFlushEvery],
    ['rebuild pending limit', rebuildMaxPending],
  ] as const) {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`The ${label} of MessagingModule is a positive integer.`);
    }
  }
  const handlerTimeoutMs: number = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  if (!(handlerTimeoutMs > 0 && handlerTimeoutMs < ACK_WAIT_MS)) {
    throw new Error(
      `The handler timeout of MessagingModule is positive and below the acknowledgement wait of ${String(ACK_WAIT_MS)} ms.`,
    );
  }
  const prefixes: Readonly<Record<string, string>> = {
    eventSubjectPrefix: options.eventSubjectPrefix ?? DEFAULT_EVENT_SUBJECT_PREFIX,
    restrictedSubjectPrefix: options.restrictedSubjectPrefix ?? DEFAULT_RESTRICTED_SUBJECT_PREFIX,
    deadLetterSubjectPrefix: options.deadLetterSubjectPrefix ?? DEFAULT_DEAD_LETTER_SUBJECT_PREFIX,
    rebuildSubjectPrefix: options.rebuildSubjectPrefix ?? DEFAULT_REBUILD_SUBJECT_PREFIX,
  };
  for (const [label, prefix] of Object.entries(prefixes)) {
    if (!NAME_PATTERN.test(prefix)) {
      throw new Error(
        `The ${label} of MessagingModule is one subject token: letters, digits, hyphens and underscores.`,
      );
    }
  }
  if (new Set(Object.values(prefixes)).size !== Object.keys(prefixes).length) {
    throw new Error(
      'The subject prefixes of MessagingModule (events, restricted events, dead letters, rebuilds) are pairwise distinct.',
    );
  }
  const eventSubjectPrefix: string = prefixes.eventSubjectPrefix ?? DEFAULT_EVENT_SUBJECT_PREFIX;
  const restrictedSubjectPrefix: string =
    prefixes.restrictedSubjectPrefix ?? DEFAULT_RESTRICTED_SUBJECT_PREFIX;
  const restrictedEvents: readonly string[] = [...(options.restrictedEvents ?? [])];
  for (const name of restrictedEvents) {
    eventSubject(restrictedSubjectPrefix, name);
  }
  const advisoryInbox = options.deadLetterAdvisories;
  if (
    advisoryInbox !== undefined &&
    (!options.deadLetterWorker ||
      !NAME_PATTERN.test(advisoryInbox.stream) ||
      !NAME_PATTERN.test(advisoryInbox.durable) ||
      (advisoryInbox.user !== undefined && !NAME_PATTERN.test(advisoryInbox.user)) ||
      (advisoryInbox.user === undefined && advisoryInbox.password !== undefined))
  ) {
    throw new Error(
      'The dead-letter advisory inbox needs an enabled worker and valid broker options.',
    );
  }
  return {
    service: options.service,
    servers: parseServers(options.servers),
    user: options.user,
    password: options.password,
    connectionName: options.connectionName ?? options.service,
    manageStreams: options.manageStreams ?? false,
    manageConsumers: options.manageConsumers ?? true,
    deadLetterWorker: options.deadLetterWorker ?? false,
    ...(advisoryInbox === undefined
      ? {}
      : {
          deadLetterAdvisories: { ...advisoryInbox, servers: parseServers(advisoryInbox.servers) },
        }),
    restrictedEvents,
    eventsStream: options.eventsStream ?? DEFAULT_EVENTS_STREAM,
    restrictedStream: options.restrictedStream ?? DEFAULT_RESTRICTED_STREAM,
    deadLetterStream: options.deadLetterStream ?? DEFAULT_DEAD_LETTER_STREAM,
    eventSubjectPrefix,
    restrictedSubjectPrefix,
    deadLetterSubjectPrefix: prefixes.deadLetterSubjectPrefix ?? DEFAULT_DEAD_LETTER_SUBJECT_PREFIX,
    rebuildSubjectPrefix: prefixes.rebuildSubjectPrefix ?? DEFAULT_REBUILD_SUBJECT_PREFIX,
    rebuildName,
    rebuildAcknowledgement: options.rebuildAcknowledgement ?? 'none',
    rebuildFlushEvery,
    rebuildMaxPending,
    handlerTimeoutMs,
    restrictedDeadLetterPayload: options.restrictedDeadLetterPayload ?? 'drop',
    eventsMaxBytes: options.eventsMaxBytes ?? DEFAULT_EVENTS_MAX_BYTES,
    restrictedMaxBytes: options.restrictedMaxBytes ?? DEFAULT_RESTRICTED_MAX_BYTES,
    deadLetterMaxBytes: options.deadLetterMaxBytes ?? DEFAULT_DEAD_LETTER_MAX_BYTES,
    deadLetterMaxAgeDays: options.deadLetterMaxAgeDays ?? DEFAULT_DEAD_LETTER_MAX_AGE_DAYS,
    publishTimeoutMs: timerDelay(
      'publishTimeoutMs',
      options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS,
    ),
    shutdownTimeoutMs: timerDelay(
      'shutdownTimeoutMs',
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    ),
    rebuildTimeoutMs: timerDelay(
      'rebuildTimeoutMs',
      options.rebuildTimeoutMs ?? DEFAULT_REBUILD_TIMEOUT_MS,
    ),
  };
}
