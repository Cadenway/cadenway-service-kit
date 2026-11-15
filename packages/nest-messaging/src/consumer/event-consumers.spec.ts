import { ClosedConnectionError } from '@nats-io/transport-node';
import { describe, expect, it } from 'vitest';

import { answerSafely, contextActorOf } from './event-consumers.js';

describe('contextActorOf', () => {
  it.each(['user', 'automation', 'git', 'system'])(
    'keeps the actor kind %s the kit knows, with its id',
    (type: string) => {
      expect(contextActorOf({ type, id: 'actor-1' })).toEqual({ type, id: 'actor-1' });
    },
  );

  it.each(['service-account', 'anonymous', ''])(
    'refuses the actor kind "%s", which the contracts do not define today',
    (type: string) => {
      expect(contextActorOf({ type, id: 'actor-1' })).toBeUndefined();
    },
  );
});

describe('answerSafely', () => {
  it('sends the answer', () => {
    const sent: string[] = [];

    answerSafely(
      () => {
        sent.push('ack');
      },
      () => {
        sent.push('error');
      },
    );

    expect(sent).toEqual(['ack']);
  });

  it('reports an answer the closed connection could not send instead of throwing', () => {
    const errors: unknown[] = [];

    expect(() => {
      answerSafely(
        () => {
          throw new ClosedConnectionError();
        },
        (error: unknown) => {
          errors.push(error);
        },
      );
    }).not.toThrow();
    expect(errors[0]).toBeInstanceOf(ClosedConnectionError);
  });
});
