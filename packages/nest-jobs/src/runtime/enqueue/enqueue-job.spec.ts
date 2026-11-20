import type { Request, SendOptions } from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';

import type { JobsTransaction } from '../../jobs/database/jobs-transaction.js';
import { enqueueJob } from './enqueue-job.js';

/**
 * Type Send
 *
 * @description
 * Accepts both pg-boss sender overloads while exposing the positional options to the test.
 *
 * @type {(request: Request | string, data?: object | null, options?: SendOptions) => Promise<string | null>}
 */
type Send = (
  request: Request | string,
  data?: object | null,
  options?: SendOptions,
) => Promise<string | null>;

describe('enqueueJob', () => {
  it('keeps the caller transaction and occurrence id when delaying a job', async () => {
    const send = vi.fn<Send>().mockResolvedValue('created-job');
    const query = vi.fn<JobsTransaction['client']['query']>().mockResolvedValue({ rows: [] });
    const tx: JobsTransaction = { organizationId: 'org-1', client: { query } };
    const startAfter: Date = new Date('2027-01-10T09:30:00.000Z');

    await enqueueJob({ send }, tx, 'reminders', {}, { occurrenceKey: 'reminder:1', startAfter });
    await enqueueJob({ send }, tx, 'reminders', {}, { occurrenceKey: 'reminder:1' });

    const withDelay = send.mock.calls[0]?.[2];
    const withoutDelay = send.mock.calls[1]?.[2];
    expect(withDelay?.startAfter).toBe(startAfter);
    expect(withDelay?.id).toBeDefined();
    expect(withoutDelay?.id).toBe(withDelay?.id);
    expect(withoutDelay).not.toHaveProperty('startAfter');
    await withDelay?.db?.executeSql('SELECT $1', ['value']);
    expect(query).toHaveBeenCalledExactlyOnceWith('SELECT $1', ['value']);
  });

  it('rejects an invalid start date before calling the sender', async () => {
    const send = vi.fn<Send>();
    const tx: JobsTransaction = {
      organizationId: null,
      client: { query: vi.fn<JobsTransaction['client']['query']>() },
    };

    await expect(
      enqueueJob({ send }, tx, 'reminders', {}, { startAfter: new Date(Number.NaN) }),
    ).rejects.toThrow(new TypeError('startAfter must be a valid Date.'));
    expect(send).not.toHaveBeenCalled();
  });
});
