import { describe, expect, it } from 'vitest';

import {
  deadLetterMessageId,
  deadLetterSubject,
  durableConsumerName,
  eventSubject,
  maxDeliveriesAdvisorySubject,
  rebuildSubject,
  terminatedAdvisorySubject,
} from './subjects.js';

describe('subjects', () => {
  it('derives the subject of an event from its contract name', () => {
    expect(eventSubject('evt', 'task.status-changed.v1')).toBe('evt.task.status-changed.v1');
  });

  it.each(['', 'task..v1', 'task.*', 'task.>', 'task updated.v1', '.task', 'task.'])(
    'refuses the event name "%s", which would change what the subject matches',
    (name: string) => {
      expect(() => eventSubject('evt', name)).toThrow(/Invalid event name/u);
    },
  );

  it('refuses a prefix that holds a wildcard', () => {
    expect(() => eventSubject('evt.>', 'task.updated.v1')).toThrow(/Invalid event subject prefix/u);
  });

  it('derives the dead-letter subject from the consumer and the original subject', () => {
    expect(deadLetterSubject('dlq', 'search-service__index-task', 'evt.task.updated.v1')).toBe(
      'dlq.search-service__index-task.evt.task.updated.v1',
    );
    expect(
      deadLetterSubject('dlq', 'notification-service__send-code', 'restricted.user.code.v1'),
    ).toBe('dlq.notification-service__send-code.restricted.user.code.v1');
  });

  it('refuses a dead-letter consumer that spans several tokens', () => {
    expect(() => deadLetterSubject('dlq', 'search.index', 'evt.task.updated.v1')).toThrow(
      /Invalid consumer name/u,
    );
  });

  it('derives the rebuild subject from the rebuild name of the consumer and the entity', () => {
    expect(rebuildSubject('rebuild', 'search', 'task')).toBe('rebuild.search.task');
  });

  it('refuses a rebuild entity that spans several tokens', () => {
    expect(() => rebuildSubject('rebuild', 'search-service', 'task.comment')).toThrow(
      /Invalid rebuild entity/u,
    );
  });

  it('names a durable consumer after the service and the handler', () => {
    expect(durableConsumerName('search-service', 'index-task')).toBe('search-service__index-task');
  });

  it.each(['index.task', 'index task', 'index*', ''])(
    'refuses the handler name "%s", which JetStream would not accept in a consumer name',
    (handler: string) => {
      expect(() => durableConsumerName('search-service', handler)).toThrow(/Invalid handler name/u);
    },
  );

  it('derives the advisory subjects of a stream', () => {
    expect(maxDeliveriesAdvisorySubject('EVENTS')).toBe(
      '$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.EVENTS.>',
    );
    expect(terminatedAdvisorySubject('EVENTS')).toBe(
      '$JS.EVENT.ADVISORY.CONSUMER.MSG_TERMINATED.EVENTS.>',
    );
  });

  it('derives the same dead-letter message id for the same consumer and sequence', () => {
    expect(deadLetterMessageId('EVENTS', 'search-service__index-task', 42)).toBe(
      'EVENTS.search-service__index-task.42',
    );
    expect(deadLetterMessageId('EVENTS', 'search-service__index-task', 42)).not.toBe(
      deadLetterMessageId('EVENTS', 'notification-service__notify', 42),
    );
  });
});
