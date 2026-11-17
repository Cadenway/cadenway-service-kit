import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import {
  checkRuntime,
  createScratch,
  entryPoints,
  install,
  minimalEntries,
  pack,
  peerVersions,
  preloadEntries,
  registryPackage,
} from './kit-fixtures.mjs';
import { readPublicApi } from './public-api.mjs';

const baseline = {
  '@cadenway/nest-common': '0.5.0',
  '@cadenway/nest-messaging': '0.2.0',
  '@cadenway/nest-jobs': '0.3.0',
};

test('packed Service Kit preserves the released public API and supports isolated optional peers', (context) => {
  const scratch = createScratch(context);

  const archives = pack(scratch);
  const minimalArchives = archives.filter(({ name }) => name !== '@cadenway/nest-jobs');
  const limited = join(scratch, 'minimal');
  const full = join(scratch, 'candidate');
  const reference = join(scratch, 'reference');
  const dependencies = (selected) =>
    Object.fromEntries(selected.map(({ name, archive }) => [name, archive]));
  const fullPeers = peerVersions(archives, false);
  const messaging = archives.find(({ name }) => name === '@cadenway/nest-messaging');
  // The kit consumes a structural schema interface. The services supply the generated contracts.
  assert.ok(messaging.manifest.peerDependencies?.['@cadenway/contracts']);
  assert.equal(messaging.manifest.peerDependenciesMeta?.['@cadenway/contracts']?.optional, true);
  install(
    limited,
    { ...peerVersions(minimalArchives, true), ...dependencies(minimalArchives) },
    minimalEntries,
  );
  install(full, { ...fullPeers, ...dependencies(archives) }, entryPoints);
  const released = Object.fromEntries(
    Object.entries(baseline).map(([name, version]) => [
      name,
      registryPackage(name, version, scratch).url,
    ]),
  );
  install(reference, { ...fullPeers, ...released }, entryPoints);

  const runtimeEntries = [...entryPoints, ...preloadEntries];
  checkRuntime(limited, [...minimalEntries, ...preloadEntries], true);
  const releasedEntries = [...entryPoints, ...preloadEntries];
  const releasedRuntime = checkRuntime(reference, releasedEntries, false);
  const candidateRuntime = checkRuntime(full, runtimeEntries, false);
  for (const entry of releasedEntries) {
    for (const name of releasedRuntime[entry]) {
      assert.ok(candidateRuntime[entry].includes(name), `Missing runtime export ${entry}#${name}`);
    }
  }

  readPublicApi(limited, minimalEntries);
  const candidateApi = readPublicApi(full, entryPoints);
  const differences = [];
  for (const [entry, signatures] of readPublicApi(reference, entryPoints)) {
    for (const [name, declarations] of signatures) {
      const candidate = candidateApi.get(entry)?.get(name);
      if (!isDeepStrictEqual(candidate, declarations)) {
        differences.push({ export: `${entry}#${name}`, released: declarations, candidate });
      }
    }
  }
  assert.deepEqual(differences, []);
});
