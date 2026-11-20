import type { PgBoss } from 'pg-boss';

import type { JobsQueryResult, JobsTransaction } from '../../jobs/database/jobs-transaction.js';
import type {
  JobEnqueueOptions,
  JobEnqueueResult,
} from '../../jobs/enqueue/job-enqueue-options.js';
import { assertOccurrenceKey, deriveOccurrenceJobId } from '../../jobs/enqueue/occurrence-id.js';
import { toJobEnvelope, type JobEnvelope } from '../../jobs/execution/job-envelope.js';

/**
 * Function enqueueJob
 *
 * @description
 * Inserts the job through the caller's transaction, using the occurrence id when supplied.
 *
 * @param {Pick<PgBoss, 'send'>} boss - Sender bound to the running pg-boss instance.
 * @param {JobsTransaction} tx - Caller transaction and its organization.
 * @param {string} queue - Validated queue name.
 * @param {unknown} payload - Job payload.
 * @param {JobEnqueueOptions} options - Optional occurrence key and earliest start.
 * @returns {Promise<JobEnqueueResult>} Job id and whether the occurrence already existed.
 * @throws {TypeError} When a supplied start date is invalid.
 */
export async function enqueueJob(
  boss: Pick<PgBoss, 'send'>,
  tx: JobsTransaction,
  queue: string,
  payload: unknown,
  options: JobEnqueueOptions,
): Promise<JobEnqueueResult> {
  const envelope: JobEnvelope = toJobEnvelope(tx.organizationId, payload);
  const occurrenceKey: unknown = options.occurrenceKey;
  if (occurrenceKey !== undefined) {
    assertOccurrenceKey(occurrenceKey);
  }
  const startAfter: unknown = options.startAfter;
  if (
    startAfter !== undefined &&
    (!(startAfter instanceof Date) || !Number.isFinite(startAfter.getTime()))
  ) {
    throw new TypeError('startAfter must be a valid Date.');
  }
  const id: string | undefined =
    occurrenceKey === undefined
      ? undefined
      : deriveOccurrenceJobId(queue, envelope.organizationId, occurrenceKey);
  const created: string | null = await boss.send(queue, envelope, {
    ...(id === undefined ? {} : { id }),
    ...(startAfter === undefined ? {} : { startAfter }),
    db: {
      executeSql: (text: string, values?: unknown[]): Promise<JobsQueryResult> =>
        tx.client.query(text, values),
    },
  });
  if (created !== null) {
    return { jobId: created, duplicate: false };
  }
  if (id === undefined) {
    throw new Error(`The job could not be created in queue "${queue}".`);
  }
  return { jobId: id, duplicate: true };
}
