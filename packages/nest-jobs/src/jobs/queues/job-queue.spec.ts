import { describe, expect, it } from 'vitest';

import {
  deadLetterQueuesOf,
  resolveJobQueue,
  resolveJobQueues,
  type JobQueueDeclaration,
  type ResolvedJobQueue,
} from './job-queue.js';

describe('resolveJobQueue', () => {
  it('applies bounded retries with backoff and a dead-letter queue by default', () => {
    expect(resolveJobQueue({ name: 'reminders' })).toEqual({
      name: 'reminders',
      retryLimit: 5,
      retryDelaySeconds: 30,
      retryBackoff: true,
      retryDelayMaxSeconds: 3_600,
      deadLetter: 'reminders.dead-letter',
      deadLetterRetentionSeconds: 1_209_600,
      expireInSeconds: 900,
      retentionSeconds: 1_209_600,
      deleteAfterSeconds: 604_800,
    });
  });

  it('keeps every declared value', () => {
    const declaration: Required<JobQueueDeclaration> = {
      name: 'webhooks/delivery',
      retryLimit: 0,
      retryDelaySeconds: 0,
      retryBackoff: true,
      retryDelayMaxSeconds: 120,
      deadLetter: 'webhooks_failed',
      deadLetterRetentionSeconds: 60,
      expireInSeconds: 86_400,
      retentionSeconds: 1,
      deleteAfterSeconds: 0,
      organizationConcurrency: 2,
    };

    expect(resolveJobQueue(declaration)).toEqual(declaration);
  });

  it('has no backoff ceiling when backoff is off', () => {
    const queue: ResolvedJobQueue = resolveJobQueue({ name: 'purge', retryBackoff: false });

    expect(queue.retryBackoff).toBe(false);
    expect(queue.retryDelayMaxSeconds).toBeNull();
  });

  it.each([
    ['an empty name', { name: '' }, /Queue name must contain only/],
    ['a name with a space', { name: 'send mail' }, /Queue name must contain only/],
    ['a name with a quote', { name: "send'mail" }, /Queue name must contain only/],
    ['a reserved name', { name: '__pgboss__send-it' }, /reserved/],
    ['an unbounded retry limit', { name: 'q', retryLimit: 21 }, /retryLimit must be an integer/],
    ['a negative retry limit', { name: 'q', retryLimit: -1 }, /retryLimit must be an integer/],
    ['a fractional retry limit', { name: 'q', retryLimit: 1.5 }, /retryLimit must be an integer/],
    ['a negative delay', { name: 'q', retryDelaySeconds: -1 }, /retryDelaySeconds must be/],
    [
      'a backoff ceiling without backoff',
      { name: 'q', retryBackoff: false, retryDelayMaxSeconds: 60 },
      /retryDelayMaxSeconds requires retryBackoff/,
    ],
    ['a zero backoff ceiling', { name: 'q', retryDelayMaxSeconds: 0 }, /retryDelayMaxSeconds/],
    ['an expiration over 24 hours', { name: 'q', expireInSeconds: 86_401 }, /expireInSeconds/],
    ['a zero expiration', { name: 'q', expireInSeconds: 0 }, /expireInSeconds/],
    ['a zero retention', { name: 'q', retentionSeconds: 0 }, /retentionSeconds/],
    [
      'a zero organization limit',
      { name: 'q', organizationConcurrency: 0 },
      /organizationConcurrency/,
    ],
    [
      'a fractional organization limit',
      { name: 'q', organizationConcurrency: 1.5 },
      /organizationConcurrency/,
    ],
    [
      'an organization limit outside the database integer range',
      { name: 'q', organizationConcurrency: 2_147_483_648 },
      /organizationConcurrency/,
    ],
    ['a negative deletion delay', { name: 'q', deleteAfterSeconds: -1 }, /deleteAfterSeconds/],
    ['itself as dead-letter queue', { name: 'q', deadLetter: 'q' }, /cannot be the queue itself/],
    ['an invalid dead-letter name', { name: 'q', deadLetter: 'dead letter' }, /deadLetter must/],
    ['a zero dead-letter retention', { name: 'q', deadLetterRetentionSeconds: 0 }, /deadLetterRet/],
  ])('rejects %s', (_case: string, declaration: JobQueueDeclaration, message: RegExp) => {
    expect(() => resolveJobQueue(declaration)).toThrow(message);
  });
});

describe('resolveJobQueues', () => {
  it('resolves the declarations in order', () => {
    const queues: readonly ResolvedJobQueue[] = resolveJobQueues([
      { name: 'reminders' },
      { name: 'digests', retryLimit: 1 },
    ]);

    expect(queues.map((queue: ResolvedJobQueue): string => queue.name)).toEqual([
      'reminders',
      'digests',
    ]);
    expect(queues[1]?.retryLimit).toBe(1);
  });

  it('accepts an empty list', () => {
    expect(resolveJobQueues([])).toEqual([]);
  });

  it('rejects a queue declared twice', () => {
    expect(() => resolveJobQueues([{ name: 'reminders' }, { name: 'reminders' }])).toThrow(
      /declared more than once/,
    );
  });

  it('rejects a dead-letter queue that is also a declared queue', () => {
    expect(() =>
      resolveJobQueues([{ name: 'reminders', deadLetter: 'digests' }, { name: 'digests' }]),
    ).toThrow(/is also a declared queue/);
  });

  it('rejects a shared dead-letter queue with two retentions', () => {
    expect(() =>
      resolveJobQueues([
        { name: 'reminders', deadLetter: 'failed', deadLetterRetentionSeconds: 60 },
        { name: 'digests', deadLetter: 'failed', deadLetterRetentionSeconds: 120 },
      ]),
    ).toThrow(/shared with different deadLetterRetentionSeconds/);
  });

  it('rejects a value that is not a list', () => {
    const notAList: unknown = { name: 'reminders' };

    expect(() => resolveJobQueues(notAList as readonly JobQueueDeclaration[])).toThrow(
      /must be an array/,
    );
  });
});

describe('deadLetterQueuesOf', () => {
  it('lists each dead-letter queue once', () => {
    const queues: readonly ResolvedJobQueue[] = resolveJobQueues([
      { name: 'reminders', deadLetter: 'failed', deadLetterRetentionSeconds: 60 },
      { name: 'digests', deadLetter: 'failed', deadLetterRetentionSeconds: 60 },
      { name: 'webhooks' },
    ]);

    expect(deadLetterQueuesOf(queues)).toEqual([
      { name: 'failed', retentionSeconds: 60 },
      { name: 'webhooks.dead-letter', retentionSeconds: 1_209_600 },
    ]);
  });
});
