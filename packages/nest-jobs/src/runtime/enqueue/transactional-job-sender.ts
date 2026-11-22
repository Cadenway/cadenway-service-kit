import { AsyncLocalStorage } from 'node:async_hooks';

import { PgBoss } from 'pg-boss';

import type {
  JobsQueryResult,
  JobsTransaction,
  JobsTransactionClient,
} from '../../jobs/database/jobs-transaction.js';
import type {
  JobEnqueueOptions,
  JobEnqueueResult,
} from '../../jobs/enqueue/job-enqueue-options.js';
import type { ResolvedJobQueue } from '../../jobs/queues/job-queue.js';
import { enqueueJob } from './enqueue-job.js';

/**
 * Class TransactionalJobSender
 *
 * @description
 * Uses the pg-boss sender API without starting the runtime or creating a dedicated pool.
 */
export class TransactionalJobSender {
  // #region Properties
  /**
   * Property transaction
   *
   * @description
   * Binds pg-boss queue metadata lookups to the same client as each submission.
   *
   * @type {AsyncLocalStorage<JobsTransactionClient>}
   * @readonly
   */
  private readonly transaction: AsyncLocalStorage<JobsTransactionClient> =
    new AsyncLocalStorage<JobsTransactionClient>();

  /**
   * Property boss
   *
   * @description
   * Submits jobs without starting pg-boss workers or timers.
   *
   * @type {PgBoss}
   * @readonly
   */
  private readonly boss: PgBoss;
  // #endregion

  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Configures an instance around a scoped adapter that never owns a connection.
   *
   * @param {string} schema - Validated schema that contains the provisioned queues.
   * @constructor
   */
  public constructor(schema: string) {
    this.boss = new PgBoss({
      schema,
      db: {
        executeSql: (text: string, values?: unknown[]): Promise<JobsQueryResult> => {
          const client: JobsTransactionClient | undefined = this.transaction.getStore();
          if (client === undefined) {
            throw new Error('A jobs producer query requires a scoped PostgreSQL client.');
          }
          return client.query(text, values);
        },
      },
    });
  }
  // #endregion

  // #region Methods
  /**
   * Method enqueue
   *
   * @description
   * Inserts a job in the caller's transaction, including queue metadata lookups on cache misses.
   *
   * @param {JobsTransaction} tx - Open transaction used for metadata queries and the job insert.
   * @param {ResolvedJobQueue} queue - Declared queue that receives the job.
   * @param {unknown} payload - JSON-serializable job data.
   * @param {JobEnqueueOptions} options - Optional occurrence key and earliest start.
   * @returns {Promise<JobEnqueueResult>} Job identifier and whether another enqueue already recorded the occurrence.
   */
  public async enqueue(
    tx: JobsTransaction,
    queue: ResolvedJobQueue,
    payload: unknown,
    options: JobEnqueueOptions,
  ): Promise<JobEnqueueResult> {
    return this.transaction.run(tx.client, () =>
      enqueueJob(this.boss, tx, queue, payload, options),
    );
  }
  // #endregion
}
