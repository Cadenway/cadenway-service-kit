import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

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

function checkReleaseVersions(archives) {
  if (process.env.KIT_PUBLISHED_PACKAGES === undefined) return;

  const published = JSON.parse(process.env.KIT_PUBLISHED_PACKAGES);
  assert.ok(
    Array.isArray(published) && published.length > 0,
    'Missing Changesets release versions',
  );
  for (const { name, version } of published) {
    const built = archives.find((archive) => archive.name === name);
    assert.ok(built && built.manifest.version === version, `Unexpected release ${name}@${version}`);
  }
}

function publishedUrl(context, directory, { name, manifest }) {
  const { url, peerMetadata } = registryPackage(name, manifest.version, directory);
  for (const [peer, info] of Object.entries(manifest.peerDependenciesMeta ?? {})) {
    if (info.optional && peerMetadata?.[peer]?.optional !== true) {
      context.diagnostic(
        `GitHub Packages metadata for ${name}@${manifest.version} omits optional peer ${peer}.`,
      );
    }
  }
  return url;
}

test('published Service Kit tarballs install with their declared peers', (context) => {
  const scratch = createScratch(context);
  const archives = pack(scratch);
  checkReleaseVersions(archives);
  const urls = new Map(
    archives.map((archive) => [archive.name, publishedUrl(context, scratch, archive)]),
  );
  const minimal = archives.filter(({ name }) => name !== '@cadenway/nest-jobs');
  const limited = join(scratch, 'minimal');
  const full = join(scratch, 'full');
  const packages = (selected) =>
    Object.fromEntries(selected.map(({ name }) => [name, urls.get(name)]));

  install(limited, { ...peerVersions(minimal, true), ...packages(minimal) }, minimalEntries);
  install(full, { ...peerVersions(archives, false), ...packages(archives) }, entryPoints);

  for (const { name, manifest } of archives) {
    const installed = JSON.parse(
      readFileSync(join(full, 'node_modules', name, 'package.json'), 'utf8'),
    );
    assert.equal(installed.name, name);
    assert.equal(installed.version, manifest.version);
    assert.deepEqual(installed.peerDependenciesMeta, manifest.peerDependenciesMeta);
  }
  checkRuntime(limited, [...minimalEntries, ...preloadEntries], true);
  checkRuntime(full, [...entryPoints, ...preloadEntries], false);
  readPublicApi(limited, minimalEntries);
  readPublicApi(full, entryPoints);
});
