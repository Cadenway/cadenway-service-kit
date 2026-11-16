import { describe, expect, it } from 'vitest';

import { describeError, stackOf } from './describe-error.js';

describe('describeError', () => {
  it('gives the name and the message of an error', () => {
    expect(describeError(new RangeError('out of bounds'))).toBe('RangeError: out of bounds');
  });

  it('leaves out the properties attached to an error', () => {
    const error: Error = Object.assign(new Error('delivery refused'), {
      payload: { email: 'someone@example.test' },
    });

    expect(describeError(error)).toBe('Error: delivery refused');
  });

  it('gives a thrown string as is', () => {
    expect(describeError('timeout')).toBe('timeout');
  });

  it('does not render a thrown object', () => {
    expect(describeError({ email: 'someone@example.test' })).toBe('a non-error value was thrown');
  });
});

describe('stackOf', () => {
  it('gives the stack of an error and nothing for another value', () => {
    const error: Error = new Error('boom');

    expect(stackOf(error)).toBe(error.stack);
    expect(stackOf('boom')).toBeUndefined();
  });
});
