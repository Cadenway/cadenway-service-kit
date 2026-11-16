import type { PgBoss, Queue, QueueResult, UpdateQueueOptions } from 'pg-boss';

import {
  DEFAULT_DELETE_AFTER_SECONDS,
  DEFAULT_EXPIRE_IN_SECONDS,
  deadLetterQueuesOf,
  type ResolvedDeadLetterQueue,
  type ResolvedJobQueue,
} from '../../jobs/queues/job-queue.js';

/**
 * Constant STANDARD_POLICY
 *
 * @description
 * The pg-boss queue policy this package relies on: no limit on queued or active jobs, so the only
 * deduplication is the occurrence key.
 *
 * @type {string}
 */
const STANDARD_POLICY: string = 'standard';

/**
 * Function toCreateOptions
 *
 * @description
 * Maps a resolved queue to the options pg-boss creates it with. Every value is explicit so a
 * change of a pg-boss default cannot change a queue silently.
 *
 * @param {ResolvedJobQueue} queue - Resolved queue declaration.
 * @returns {Omit<Queue, 'name'>} Options for `createQueue`.
 */
function toCreateOptions(queue: ResolvedJobQueue): Omit<Queue, 'name'> {
  return {
    policy: STANDARD_POLICY,
    retryLimit: queue.retryLimit,
    retryDelay: queue.retryDelaySeconds,
    retryBackoff: queue.retryBackoff,
    ...(queue.retryDelayMaxSeconds === null ? {} : { retryDelayMax: queue.retryDelayMaxSeconds }),
    expireInSeconds: queue.expireInSeconds,
    retentionSeconds: queue.retentionSeconds,
    deleteAfterSeconds: queue.deleteAfterSeconds,
    deadLetter: queue.deadLetter,
  };
}

/**
 * Function toUpdateOptions
 *
 * @description
 * Maps a resolved queue to the options an existing queue is updated with, so a changed declaration
 * reaches the database at the next provisioning run. Jobs already stored keep the retry policy they
 * were enqueued with.
 *
 * @param {ResolvedJobQueue} queue - Resolved queue declaration.
 * @returns {UpdateQueueOptions} Options for `updateQueue`.
 */
function toUpdateOptions(queue: ResolvedJobQueue): UpdateQueueOptions {
  return {
    retryLimit: queue.retryLimit,
    retryDelay: queue.retryDelaySeconds,
    retryBackoff: queue.retryBackoff,
    retryDelayMax: queue.retryDelayMaxSeconds,
    expireInSeconds: queue.expireInSeconds,
    retentionSeconds: queue.retentionSeconds,
    deleteAfterSeconds: queue.deleteAfterSeconds,
    deadLetter: queue.deadLetter,
  };
}

/**
 * Type DeadLetterQueueOptions
 *
 * @description
 * The options a dead-letter queue is created and updated with: the subset both pg-boss calls
 * accept unchanged.
 *
 * @type {Required<Pick<Queue, 'retryLimit' | 'retryDelay' | 'retryBackoff' | 'expireInSeconds' | 'retentionSeconds' | 'deleteAfterSeconds'>>}
 */
type DeadLetterQueueOptions = Required<
  Pick<
    Queue,
    | 'retryLimit'
    | 'retryDelay'
    | 'retryBackoff'
    | 'expireInSeconds'
    | 'retentionSeconds'
    | 'deleteAfterSeconds'
  >
>;

/**
 * Function toDeadLetterOptions
 *
 * @description
 * Options of a dead-letter queue: a parking place. Nothing consumes it, so it has no retry and no
 * dead-letter queue of its own, and a dead letter is deleted once its retention has passed.
 *
 * @param {ResolvedDeadLetterQueue} deadLetter - Dead-letter queue derived from the declarations.
 * @returns {DeadLetterQueueOptions} Options valid for both `createQueue` and `updateQueue`.
 */
function toDeadLetterOptions(deadLetter: ResolvedDeadLetterQueue): DeadLetterQueueOptions {
  return {
    retryLimit: 0,
    retryDelay: 0,
    retryBackoff: false,
    expireInSeconds: DEFAULT_EXPIRE_IN_SECONDS,
    retentionSeconds: deadLetter.retentionSeconds,
    deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS,
  };
}

/**
 * Function ensureQueue
 *
 * @description
 * Creates a queue, or updates it when it already exists. Safe to run from two containers at once:
 * pg-boss creates a queue with `ON CONFLICT DO NOTHING` under an advisory lock.
 *
 * @param {PgBoss} boss - Started pg-boss instance of the migrator role.
 * @param {string} name - Queue name.
 * @param {Omit<Queue, 'name'>} createOptions - Options used when the queue does not exist.
 * @param {UpdateQueueOptions} updateOptions - Options applied when it does.
 * @returns {Promise<void>} Resolves once the queue matches its declaration.
 * @throws {Error} When an existing queue has another policy than the one this package relies on.
 */
async function ensureQueue(
  boss: PgBoss,
  name: string,
  createOptions: Omit<Queue, 'name'>,
  updateOptions: UpdateQueueOptions,
): Promise<void> {
  const existing: QueueResult | null = await boss.getQueue(name);
  if (existing === null) {
    await boss.createQueue(name, createOptions);
    return;
  }
  if (existing.policy !== STANDARD_POLICY) {
    throw new Error(
      `Queue "${name}" exists with policy "${String(existing.policy)}": only "${STANDARD_POLICY}" queues are supported.`,
    );
  }
  await boss.updateQueue(name, updateOptions);
}

/**
 * Function provisionQueues
 *
 * @description
 * Creates or updates the declared queues after preparing their dead-letter queues.
 *
 * @param {PgBoss} boss - Started pg-boss instance of the migrator role.
 * @param {readonly ResolvedJobQueue[]} queues - Resolved queue declarations.
 * @returns {Promise<void>} Resolves once the queues match their declarations.
 */
export async function provisionQueues(
  boss: PgBoss,
  queues: readonly ResolvedJobQueue[],
): Promise<void> {
  for (const deadLetter of deadLetterQueuesOf(queues)) {
    const options: DeadLetterQueueOptions = toDeadLetterOptions(deadLetter);
    await ensureQueue(
      boss,
      deadLetter.name,
      { ...options, policy: STANDARD_POLICY },
      { ...options, deadLetter: null, retryDelayMax: null },
    );
  }
  for (const queue of queues) {
    await ensureQueue(boss, queue.name, toCreateOptions(queue), toUpdateOptions(queue));
  }
}
