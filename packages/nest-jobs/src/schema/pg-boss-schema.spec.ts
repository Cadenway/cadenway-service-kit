import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { expectedSchemaVersion } from './pg-boss-schema.js';

describe('expectedSchemaVersion', () => {
  it('reads the schema version of the pinned pg-boss release', () => {
    // A change of this number means pg-boss was bumped to a release with another schema: it is a
    // release of the kit with a migration note, and the services must provision before they start.
    expect(expectedSchemaVersion()).toBe(46);
  });

  it('goes with a pg-boss dependency pinned to one exact version', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );

    expect(manifest).toMatchObject({
      dependencies: { 'pg-boss': expect.stringMatching(/^\d+\.\d+\.\d+$/) as string },
    });
  });
});
