import { AsyncLocalStorage } from 'node:async_hooks';

import type { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { PgBoss } from 'pg-boss';

import type { ResolvedJobsModuleOptions } from '../../jobs/configuration/jobs-options.js';
import type {
  JobsQueryResult,
  JobsTransaction,
  JobsTransactionClient,
} from '../../jobs/database/jobs-transaction.js';
import type {
  JobEnqueueOptions,
  JobEnqueueResult,
} from '../../jobs/enqueue/job-enqueue-options.js';
import type { ResolvedDeadLetterQueue } from '../../jobs/queues/job-queue.js';
import { expectedSchemaVersion } from '../../schema/pg-boss-schema.js';
import { fieldOf } from '../postgres/database-row.js';
import { toStartupError, verifyJobsDatabase } from '../postgres/jobs-startup-checks.js';
import { enqueueJob } from './enqueue-job.js';

/** Uses the pg-boss sender API without starting the runtime or creating a dedicated pool. */
export class TransactionalJobSender {
  // #region Properties
  /** Binds pg-boss queue metadata lookups to the same client as each submission. */
  private readonly transaction: AsyncLocalStorage<JobsTransactionClient> =
    new AsyncLocalStorage<JobsTransactionClient>();

  /** Instance used for submission and read-only verification. */
  private readonly boss: PgBoss;
  // #endregion

  // #region Constructor
  /** Configures an instance around a scoped adapter that never owns a connection. */
  public constructor(private readonly options: ResolvedJobsModuleOptions) {
    this.boss = new PgBoss({
      schema: options.schema,
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
  /** Checks the provisioned schema and queues using one temporary application-role connection. */
  public async verify(
    deadLetterQueues: readonly ResolvedDeadLetterQueue[],
    logger: Logger,
  ): Promise<void> {
    const client: Client = new Client({
      ...this.options.connection,
      connectionTimeoutMillis: 10_000,
    });
    try {
      await client.connect();
      const versionTable: string = `${this.options.schema}.version`;
      const table: JobsQueryResult = await client.query('SELECT to_regclass($1) AS relation', [
        versionTable,
      ]);
      if (fieldOf(table.rows[0], 'relation') === null) {
        throw toStartupError(new Error('pg-boss is not installed'), this.options.schema);
      }
      const version: JobsQueryResult = await client.query(`SELECT version FROM ${versionTable}`);
      if (fieldOf(version.rows[0], 'version') !== expectedSchemaVersion()) {
        throw toStartupError(
          new Error('pg-boss database requires migrations'),
          this.options.schema,
        );
      }
      await this.transaction.run(client, () =>
        verifyJobsDatabase(this.boss, this.options, deadLetterQueues, logger, false),
      );
    } catch (error) {
      throw toStartupError(error, this.options.schema);
    } finally {
      await client.end();
    }
  }

  /** Inserts a job in the caller's transaction, including queue metadata lookups on cache misses. */
  public async enqueue(
    tx: JobsTransaction,
    queue: string,
    payload: unknown,
    options: JobEnqueueOptions,
  ): Promise<JobEnqueueResult> {
    return this.transaction.run(tx.client, () =>
      enqueueJob(this.boss, tx, queue, payload, options),
    );
  }
  // #endregion
}
