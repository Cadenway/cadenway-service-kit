import { Logger } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';

import { resolveJobsModuleOptions } from '../../jobs/configuration/jobs-options.js';
import type { Job } from '../../jobs/execution/job.js';
import { JobWorkers } from './job-workers.js';

describe('JobWorkers', () => {
  it('still reports a running retry at shutdown after the original handler returns', async () => {
    const connection = { host: 'database.internal', user: 'app', database: 'test' };
    const options = resolveJobsModuleOptions({ connection, queues: [{ name: 'reminders' }] });
    const queue = options.queues[0];
    if (queue === undefined) {
      throw new Error('Expected a resolved queue.');
    }
    const boss = new PgBoss(connection);
    const work = vi.spyOn(boss, 'work').mockResolvedValue('worker');
    const logger = new Logger('JobsService');
    const warnings = vi.spyOn(logger, 'warn').mockImplementation((): void => undefined);
    const workers = new JobWorkers(options, logger);
    let finishOriginal: () => void = (): void => undefined;
    const original: Promise<void> = new Promise<void>((resolve: () => void): void => {
      finishOriginal = resolve;
    });
    let finishRetry: () => void = (): void => undefined;
    const retry: Promise<void> = new Promise<void>((resolve: () => void): void => {
      finishRetry = resolve;
    });
    await workers.register(
      boss,
      queue,
      (job: Job): Promise<void> => (job.attempt === 1 ? original : retry),
      { concurrency: 2 },
    );
    const run = work.mock.lastCall?.[2];
    if (run === undefined) {
      throw new Error('Expected a registered worker.');
    }
    const originalSignal = new AbortController();
    const job = {
      id: 'job-id',
      name: queue.name,
      data: { organizationId: null, payload: null },
      retryCount: 0,
      retryLimit: 2,
      expireInSeconds: 600,
      heartbeatSeconds: null,
      deadLetter: queue.deadLetter,
      signal: originalSignal.signal,
    };

    const first = run([job]);
    originalSignal.abort();
    const second = run([{ ...job, retryCount: 1, signal: new AbortController().signal }]);
    try {
      finishOriginal();
      await first;

      const interrupted = expect(second).rejects.toThrow('shutdown timeout of 1000 ms');
      workers.interruptRunning(1_000);
      await interrupted;

      expect(warnings).toHaveBeenCalledWith(
        'Job job-id of queue "reminders" failed attempt 2 of 3 and will be retried: it was still running when the shutdown timeout of 1000 ms passed',
      );
    } finally {
      finishRetry();
      await second.catch(() => undefined);
    }
  });
});
