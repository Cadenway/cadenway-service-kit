/**
 * Constant QUEUE_NAME_PATTERN
 *
 * @description
 * Characters pg-boss accepts in a queue name: letters, digits, underscores, hyphens, periods and
 * forward slashes. Checked here so a bad name is refused before any statement is sent.
 *
 * @type {RegExp}
 */
const QUEUE_NAME_PATTERN: RegExp = /^[\w.\-/]+$/u;

/**
 * Constant RESERVED_QUEUE_PREFIX
 *
 * @description
 * Prefix of the queues pg-boss creates for its own use, such as the one that forwards schedules.
 *
 * @type {string}
 */
const RESERVED_QUEUE_PREFIX: string = '__pgboss__';

/**
 * Constant MAX_RETRY_LIMIT
 *
 * @description
 * Highest accepted `retryLimit`. Retries are bounded by design: a larger number is refused instead
 * of letting a job be retried for weeks.
 *
 * @type {number}
 */
export const MAX_RETRY_LIMIT: number = 20;

/**
 * Constant MAX_EXPIRE_IN_SECONDS
 *
 * @description
 * Longest time pg-boss lets a job stay active, 24 hours, in seconds.
 *
 * @type {number}
 */
export const MAX_EXPIRE_IN_SECONDS: number = 86_400;

/** Largest integer accepted by the broker's group-limit query. */
const maxOrganizationConcurrency = 2_147_483_647;

/**
 * Constant DEFAULT_RETRY_LIMIT
 *
 * @description
 * Retries after the first attempt when a declaration sets none: a job runs at most six times.
 *
 * @type {number}
 */
export const DEFAULT_RETRY_LIMIT: number = 5;

/**
 * Constant DEFAULT_RETRY_DELAY_SECONDS
 *
 * @description
 * Base delay before a retry, in seconds, when a declaration sets none.
 *
 * @type {number}
 */
export const DEFAULT_RETRY_DELAY_SECONDS: number = 30;

/**
 * Constant DEFAULT_RETRY_DELAY_MAX_SECONDS
 *
 * @description
 * Ceiling of the exponential backoff, one hour in seconds, when a declaration sets none.
 *
 * @type {number}
 */
export const DEFAULT_RETRY_DELAY_MAX_SECONDS: number = 3_600;

/**
 * Constant DEFAULT_EXPIRE_IN_SECONDS
 *
 * @description
 * Time a handler may run before the attempt is failed, 15 minutes in seconds.
 *
 * @type {number}
 */
export const DEFAULT_EXPIRE_IN_SECONDS: number = 900;

/**
 * Constant DEFAULT_RETENTION_SECONDS
 *
 * @description
 * Time a job may wait without being started before it is deleted, 14 days in seconds. Also the
 * default time a dead letter is kept.
 *
 * @type {number}
 */
export const DEFAULT_RETENTION_SECONDS: number = 1_209_600;

/**
 * Constant DEFAULT_DELETE_AFTER_SECONDS
 *
 * @description
 * Time a finished job row is kept, 7 days in seconds. An occurrence key is enforced for at least
 * this long after the job finished.
 *
 * @type {number}
 */
export const DEFAULT_DELETE_AFTER_SECONDS: number = 604_800;

/**
 * Constant DEAD_LETTER_SUFFIX
 *
 * @description
 * Appended to a queue name to build the name of its default dead-letter queue.
 *
 * @type {string}
 */
export const DEAD_LETTER_SUFFIX: string = '.dead-letter';

/**
 * Interface JobQueueDeclaration
 *
 * @description
 * Declares one queue of a service and its retry policy. The same list is given to `provisionJobs`,
 * which creates or updates the queues, and to `JobsModule`, which checks at start-up that they
 * exist. Every field but `name` has a default; a default never changes without a major release.
 */
export interface JobQueueDeclaration {
  // #region Properties
  /**
   * Property name
   *
   * @description
   * Queue name: letters, digits, underscores, hyphens, periods and forward slashes. Names starting
   * with `__pgboss__` are reserved.
   *
   * @type {string}
   * @readonly
   */
  readonly name: string;

  /**
   * Property retryLimit
   *
   * @description
   * Retries after the first attempt, from 0 to 20. A job runs at most `retryLimit + 1` times, then
   * moves to the dead-letter queue. Defaults to 5.
   *
   * @type {number}
   * @readonly
   */
  readonly retryLimit?: number;

  /**
   * Property retryDelaySeconds
   *
   * @description
   * Base delay before a retry, in whole seconds. With backoff the delay before retry `n` is drawn
   * between `retryDelaySeconds * 2^(n-1)` and `retryDelaySeconds * 2^n`. Defaults to 30.
   *
   * @type {number}
   * @readonly
   */
  readonly retryDelaySeconds?: number;

  /**
   * Property retryBackoff
   *
   * @description
   * Whether the delay doubles at each retry, with jitter. When `false` every retry waits exactly
   * `retryDelaySeconds`. Defaults to `true`.
   *
   * @type {boolean}
   * @readonly
   */
  readonly retryBackoff?: boolean;

  /**
   * Property retryDelayMaxSeconds
   *
   * @description
   * Ceiling of the backoff delay, in whole seconds. Only accepted with `retryBackoff`. Defaults to
   * 3600.
   *
   * @type {number}
   * @readonly
   */
  readonly retryDelayMaxSeconds?: number;

  /**
   * Property deadLetter
   *
   * @description
   * Name of the queue that receives a job once its last attempt failed. Several queues may share
   * one. It cannot be a declared queue. Defaults to `<name>.dead-letter`.
   *
   * @type {string}
   * @readonly
   */
  readonly deadLetter?: string;

  /**
   * Property deadLetterRetentionSeconds
   *
   * @description
   * Time a dead letter is kept before maintenance deletes it, in whole seconds. Queues sharing a
   * dead-letter queue must agree on it. Defaults to 1209600 (14 days).
   *
   * @type {number}
   * @readonly
   */
  readonly deadLetterRetentionSeconds?: number;

  /**
   * Property expireInSeconds
   *
   * @description
   * Time a handler may run before the attempt is failed and retried, from 1 to 86400 seconds.
   * Defaults to 900 (15 minutes).
   *
   * @type {number}
   * @readonly
   */
  readonly expireInSeconds?: number;

  /**
   * Property retentionSeconds
   *
   * @description
   * Time a job may wait without being started before maintenance deletes it, in whole seconds,
   * counted again at each retry. Defaults to 1209600 (14 days).
   *
   * @type {number}
   * @readonly
   */
  readonly retentionSeconds?: number;

  /**
   * Property deleteAfterSeconds
   *
   * @description
   * Time a finished job row (completed or failed) is kept, in whole seconds. An occurrence key is
   * enforced for at least this long after the job finished. `0` keeps finished rows forever.
   * Defaults to 604800 (7 days).
   *
   * @type {number}
   * @readonly
   */
  readonly deleteAfterSeconds?: number;

  /** Maximum concurrent jobs from one organization across replicas. Omit for no group limit. */
  readonly organizationConcurrency?: number;
  // #endregion
}

/**
 * Interface ResolvedJobQueue
 *
 * @description
 * A queue declaration with every default applied and every value validated.
 */
export interface ResolvedJobQueue {
  // #region Properties
  /**
   * Property name
   *
   * @description
   * Queue name.
   *
   * @type {string}
   * @readonly
   */
  readonly name: string;

  /**
   * Property retryLimit
   *
   * @description
   * Retries after the first attempt.
   *
   * @type {number}
   * @readonly
   */
  readonly retryLimit: number;

  /**
   * Property retryDelaySeconds
   *
   * @description
   * Base delay before a retry, in seconds.
   *
   * @type {number}
   * @readonly
   */
  readonly retryDelaySeconds: number;

  /**
   * Property retryBackoff
   *
   * @description
   * Whether the delay doubles at each retry.
   *
   * @type {boolean}
   * @readonly
   */
  readonly retryBackoff: boolean;

  /**
   * Property retryDelayMaxSeconds
   *
   * @description
   * Ceiling of the backoff delay in seconds, or `null` when backoff is off.
   *
   * @type {number | null}
   * @readonly
   */
  readonly retryDelayMaxSeconds: number | null;

  /**
   * Property deadLetter
   *
   * @description
   * Name of the dead-letter queue.
   *
   * @type {string}
   * @readonly
   */
  readonly deadLetter: string;

  /**
   * Property deadLetterRetentionSeconds
   *
   * @description
   * Time a dead letter is kept, in seconds.
   *
   * @type {number}
   * @readonly
   */
  readonly deadLetterRetentionSeconds: number;

  /**
   * Property expireInSeconds
   *
   * @description
   * Time a handler may run, in seconds.
   *
   * @type {number}
   * @readonly
   */
  readonly expireInSeconds: number;

  /**
   * Property retentionSeconds
   *
   * @description
   * Time a job may wait without being started, in seconds.
   *
   * @type {number}
   * @readonly
   */
  readonly retentionSeconds: number;

  /**
   * Property deleteAfterSeconds
   *
   * @description
   * Time a finished job row is kept, in seconds; `0` keeps it forever.
   *
   * @type {number}
   * @readonly
   */
  readonly deleteAfterSeconds: number;

  /** Validated optional organization-level concurrency for this queue. */
  readonly organizationConcurrency?: number;
  // #endregion
}

/**
 * Interface ResolvedDeadLetterQueue
 *
 * @description
 * A dead-letter queue derived from the declarations that name it.
 */
export interface ResolvedDeadLetterQueue {
  // #region Properties
  /**
   * Property name
   *
   * @description
   * Name of the dead-letter queue.
   *
   * @type {string}
   * @readonly
   */
  readonly name: string;

  /**
   * Property retentionSeconds
   *
   * @description
   * Time a dead letter is kept, in seconds.
   *
   * @type {number}
   * @readonly
   */
  readonly retentionSeconds: number;
  // #endregion
}

/**
 * Function assertQueueName
 *
 * @description
 * Refuses a queue name pg-boss would reject or that collides with its internal queues.
 *
 * @param {unknown} name - Candidate queue name.
 * @param {string} label - What the name designates, used in the error message.
 * @throws {Error} When the name is not a usable queue name.
 */
export function assertQueueName(name: unknown, label: string): asserts name is string {
  if (typeof name !== 'string' || !QUEUE_NAME_PATTERN.test(name)) {
    throw new Error(
      `${label} must contain only letters, digits, underscores, hyphens, periods or forward slashes.`,
    );
  }
  if (name.startsWith(RESERVED_QUEUE_PREFIX)) {
    throw new Error(
      `${label} cannot start with "${RESERVED_QUEUE_PREFIX}": the prefix is reserved.`,
    );
  }
}

/**
 * Function integerOption
 *
 * @description
 * Reads an optional whole number of a declaration, applying its default and its bounds.
 *
 * @param {string} queue - Queue the option belongs to, used in the error message.
 * @param {string} option - Option name, used in the error message.
 * @param {number | undefined} value - Declared value, if any.
 * @param {number} fallback - Value used when none is declared.
 * @param {number} minimum - Lowest accepted value.
 * @param {number} maximum - Highest accepted value.
 * @returns {number} The declared value or the default.
 * @throws {Error} When the declared value is not an integer within the bounds.
 */
function integerOption(
  queue: string,
  option: string,
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    const upper: string = maximum === Number.MAX_SAFE_INTEGER ? '' : ` and ${String(maximum)}`;
    const range: string =
      upper === '' ? `at least ${String(minimum)}` : `between ${String(minimum)}${upper}`;
    throw new Error(`Queue "${queue}": ${option} must be an integer ${range}.`);
  }
  return value;
}

/**
 * Function resolveJobQueue
 *
 * @description
 * Applies the defaults of one declaration and validates it.
 *
 * @param {JobQueueDeclaration} declaration - Queue declaration written by the service.
 * @returns {ResolvedJobQueue} The declaration with every value set.
 * @throws {Error} When a value is out of bounds or the dead-letter queue is the queue itself.
 */
export function resolveJobQueue(declaration: JobQueueDeclaration): ResolvedJobQueue {
  const name: unknown = declaration.name;
  assertQueueName(name, 'Queue name');
  const retryBackoff: boolean = declaration.retryBackoff ?? true;
  if (!retryBackoff && declaration.retryDelayMaxSeconds !== undefined) {
    throw new Error(`Queue "${name}": retryDelayMaxSeconds requires retryBackoff.`);
  }
  const deadLetter: unknown = declaration.deadLetter ?? `${name}${DEAD_LETTER_SUFFIX}`;
  assertQueueName(deadLetter, `Queue "${name}": deadLetter`);
  if (deadLetter === name) {
    throw new Error(`Queue "${name}": deadLetter cannot be the queue itself.`);
  }
  const unbounded: number = Number.MAX_SAFE_INTEGER;
  return {
    name,
    ...(declaration.organizationConcurrency === undefined
      ? {}
      : {
          organizationConcurrency: integerOption(
            name,
            'organizationConcurrency',
            declaration.organizationConcurrency,
            1,
            1,
            maxOrganizationConcurrency,
          ),
        }),
    retryLimit: integerOption(
      name,
      'retryLimit',
      declaration.retryLimit,
      DEFAULT_RETRY_LIMIT,
      0,
      MAX_RETRY_LIMIT,
    ),
    retryDelaySeconds: integerOption(
      name,
      'retryDelaySeconds',
      declaration.retryDelaySeconds,
      DEFAULT_RETRY_DELAY_SECONDS,
      0,
      unbounded,
    ),
    retryBackoff,
    retryDelayMaxSeconds: retryBackoff
      ? integerOption(
          name,
          'retryDelayMaxSeconds',
          declaration.retryDelayMaxSeconds,
          DEFAULT_RETRY_DELAY_MAX_SECONDS,
          1,
          unbounded,
        )
      : null,
    deadLetter,
    deadLetterRetentionSeconds: integerOption(
      name,
      'deadLetterRetentionSeconds',
      declaration.deadLetterRetentionSeconds,
      DEFAULT_RETENTION_SECONDS,
      1,
      unbounded,
    ),
    expireInSeconds: integerOption(
      name,
      'expireInSeconds',
      declaration.expireInSeconds,
      DEFAULT_EXPIRE_IN_SECONDS,
      1,
      MAX_EXPIRE_IN_SECONDS,
    ),
    retentionSeconds: integerOption(
      name,
      'retentionSeconds',
      declaration.retentionSeconds,
      DEFAULT_RETENTION_SECONDS,
      1,
      unbounded,
    ),
    deleteAfterSeconds: integerOption(
      name,
      'deleteAfterSeconds',
      declaration.deleteAfterSeconds,
      DEFAULT_DELETE_AFTER_SECONDS,
      0,
      unbounded,
    ),
  };
}

/**
 * Function resolveJobQueues
 *
 * @description
 * Resolves a whole declaration list and checks it as a set: names are unique, a dead-letter queue
 * is never a declared queue, and queues sharing a dead-letter queue agree on its retention.
 *
 * @param {readonly JobQueueDeclaration[]} declarations - Queue declarations of the service.
 * @returns {readonly ResolvedJobQueue[]} The resolved queues, in declaration order.
 * @throws {Error} When a declaration is invalid or the set is inconsistent.
 */
export function resolveJobQueues(
  declarations: readonly JobQueueDeclaration[],
): readonly ResolvedJobQueue[] {
  if (!Array.isArray(declarations)) {
    throw new Error('queues must be an array of queue declarations.');
  }
  const queues: ResolvedJobQueue[] = declarations.map(resolveJobQueue);
  const names: Set<string> = new Set<string>();
  for (const queue of queues) {
    if (names.has(queue.name)) {
      throw new Error(`Queue "${queue.name}" is declared more than once.`);
    }
    names.add(queue.name);
  }
  const retentions: Map<string, number> = new Map<string, number>();
  for (const queue of queues) {
    if (names.has(queue.deadLetter)) {
      throw new Error(
        `Queue "${queue.name}": deadLetter "${queue.deadLetter}" is also a declared queue.`,
      );
    }
    const shared: number | undefined = retentions.get(queue.deadLetter);
    if (shared !== undefined && shared !== queue.deadLetterRetentionSeconds) {
      throw new Error(
        `Dead-letter queue "${queue.deadLetter}" is shared with different deadLetterRetentionSeconds.`,
      );
    }
    retentions.set(queue.deadLetter, queue.deadLetterRetentionSeconds);
  }
  return queues;
}

/**
 * Function deadLetterQueuesOf
 *
 * @description
 * Lists the distinct dead-letter queues a resolved declaration list needs.
 *
 * @param {readonly ResolvedJobQueue[]} queues - Queues resolved by `resolveJobQueues`.
 * @returns {readonly ResolvedDeadLetterQueue[]} One entry per dead-letter queue, in first-use order.
 */
export function deadLetterQueuesOf(
  queues: readonly ResolvedJobQueue[],
): readonly ResolvedDeadLetterQueue[] {
  const deadLetters: Map<string, ResolvedDeadLetterQueue> = new Map<
    string,
    ResolvedDeadLetterQueue
  >();
  for (const queue of queues) {
    if (!deadLetters.has(queue.deadLetter)) {
      deadLetters.set(queue.deadLetter, {
        name: queue.deadLetter,
        retentionSeconds: queue.deadLetterRetentionSeconds,
      });
    }
  }
  return [...deadLetters.values()];
}
