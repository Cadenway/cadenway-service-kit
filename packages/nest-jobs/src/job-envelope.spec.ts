import { describe, expect, it } from 'vitest';

import { readJobEnvelope, toJobEnvelope, type JobEnvelope } from './job-envelope.js';

describe('toJobEnvelope', () => {
  it('stores the payload with its organization', () => {
    expect(toJobEnvelope('org-1', { reminderId: 'r-1' })).toEqual({
      organizationId: 'org-1',
      payload: { reminderId: 'r-1' },
    });
  });

  it('stores an absent payload as null so the envelope survives JSON', () => {
    const envelope: JobEnvelope = toJobEnvelope(null, undefined);

    expect(envelope).toEqual({ organizationId: null, payload: null });
    expect(readJobEnvelope(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope);
  });

  it.each([[undefined], [42], [{ id: 'org-1' }]])(
    'rejects the organization id %j',
    (organizationId: unknown) => {
      expect(() => toJobEnvelope(organizationId, {})).toThrow(/organizationId must be a string/);
    },
  );
});

describe('readJobEnvelope', () => {
  it('reads back what was stored', () => {
    const stored: unknown = JSON.parse(
      JSON.stringify(toJobEnvelope('org-1', { reminderId: 'r-1', occurrence: 3 })),
    );

    expect(readJobEnvelope(stored)).toEqual({
      organizationId: 'org-1',
      payload: { reminderId: 'r-1', occurrence: 3 },
    });
  });

  it.each([
    ['null', null],
    ['a string', 'reminder'],
    ['a bare payload', { reminderId: 'r-1' }],
    ['a missing payload', { organizationId: 'org-1' }],
    ['a missing organization', { payload: {} }],
    ['a numeric organization', { organizationId: 7, payload: {} }],
  ])('rejects %s', (_case: string, data: unknown) => {
    expect(() => readJobEnvelope(data)).toThrow(/not an envelope written by @cadenway\/nest-jobs/);
  });
});
