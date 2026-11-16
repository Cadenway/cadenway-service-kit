import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readPublicApi } from './public-api.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const baseline = {
  '@cadenway/nest-common': '0.4.2',
  '@cadenway/nest-messaging': '0.1.3',
  '@cadenway/nest-jobs': '0.2.0',
};
const contractsPeerVersion = '0.5.0';
const entryPoints = [
  '@cadenway/nest-common',
  '@cadenway/nest-common/database',
  '@cadenway/nest-common/redis',
  '@cadenway/nest-common/telemetry',
  '@cadenway/nest-messaging',
  '@cadenway/nest-messaging/outbox',
  '@cadenway/nest-jobs',
];
const minimalEntries = [
  '@cadenway/nest-common',
  '@cadenway/nest-common/telemetry',
  '@cadenway/nest-messaging',
];
const preloadEntries = ['@cadenway/nest-common/hook.mjs', '@cadenway/nest-common/register'];

function run(executable, args, cwd) {
  return execFileSync(executable, args, { cwd, encoding: 'utf8', timeout: 90_000 }).trim();
}

function pnpm(args, cwd) {
  const executable = process.env.npm_execpath;
  assert.ok(executable, 'Run the archive tests through pnpm test:packaging.');
  if (/\.[cm]?js$/u.test(executable)) {
    return run(process.execPath, [executable, ...args], cwd);
  }
  return run(executable, args, cwd);
}

function pack(destination) {
  return Object.keys(baseline).map((name) => {
    const packed = JSON.parse(
      pnpm(['--filter', name, 'pack', '--pack-destination', destination, '--json'], repository),
    );
    const result = Array.isArray(packed) ? packed[0] : packed;
    assert.equal(result.name, name);
    for (const { path } of result.files) {
      assert.doesNotMatch(
        path,
        /(?:^|\/)(?:tests?|testing|coverage|src)\/|\.(?:spec|test|int-spec)\.|\.tsbuildinfo$/u,
      );
    }
    const manifest = JSON.parse(
      run('tar', ['-xOf', result.filename, 'package/package.json'], repository),
    );
    for (const entries of [manifest.dependencies, manifest.peerDependencies]) {
      for (const range of Object.values(entries ?? {})) {
        assert.doesNotMatch(range, /^(?:catalog|workspace|link|file):/u);
      }
    }
    return { name, archive: result.filename, manifest };
  });
}

function readVersion(name, from) {
  const require = createRequire(join(from, 'package.json'));
  let current = dirname(require.resolve(name));
  while (true) {
    const file = join(current, 'package.json');
    if (existsSync(file)) {
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      if (manifest.name === name) return manifest.version;
    }
    const parent = dirname(current);
    assert.notEqual(parent, current, `Cannot find the installed version of ${name}`);
    current = parent;
  }
}

function peerVersions(archives, minimal) {
  const versions = new Map();
  for (const { name, manifest } of archives) {
    for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (peer.startsWith('@cadenway/') || versions.has(peer)) continue;
      if (minimal && manifest.peerDependenciesMeta?.[peer]?.optional) continue;
      if (minimal) {
        const minimum = /^(?:[~^])?(\d+\.\d+\.\d+)$/u.exec(range)?.[1];
        assert.ok(minimum, `Declare an explicit compatibility fixture for ${peer}@${range}`);
        versions.set(peer, minimum);
      } else {
        versions.set(peer, readVersion(peer, join(repository, 'packages', basename(name))));
      }
    }
  }
  return Object.fromEntries(versions);
}

function install(directory, dependencies, imports) {
  mkdirSync(directory);
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ private: true, type: 'module', dependencies }),
  );
  writeFileSync(join(directory, 'pnpm-workspace.yaml'), 'autoInstallPeers: false\n');
  writeFileSync(join(directory, '.npmrc'), '@cadenway:registry=https://npm.pkg.github.com\n');
  writeFileSync(
    join(directory, 'consumer.mts'),
    imports
      .map(
        (entry, index) =>
          `import * as item${index} from ${JSON.stringify(entry)}; void item${index};`,
      )
      .join('\n'),
  );
  pnpm(
    ['install', '--ignore-scripts', '--strict-peer-dependencies', '--prefer-offline'],
    directory,
  );
}

function checkRuntime(directory, entries, minimal) {
  const script = `
    import assert from 'node:assert/strict';
    import 'reflect-metadata';
    const entries = ${JSON.stringify(entries)};
    const exportsByEntry = {};
    for (const entry of entries) exportsByEntry[entry] = Object.keys(await import(entry)).sort();
    if (${minimal}) {
      for (const peer of ['pg', 'drizzle-orm', 'ioredis']) {
        assert.throws(() => import.meta.resolve(peer), { code: 'ERR_MODULE_NOT_FOUND' });
      }
    } else {
      const { JobsModule, JobsService } = await import('@cadenway/nest-jobs');
      assert.ok(JobsModule.forRootAsync({ useFactory: () => assert.fail('unexpected startup') }).exports.includes(JobsService));
    }
    const { MessagingModule, EventConsumers } = await import('@cadenway/nest-messaging');
    assert.ok(MessagingModule.forRootAsync({ useFactory: () => assert.fail('unexpected startup') }).exports.includes(EventConsumers));
    for (const key of Object.keys(process.env)) if (key.startsWith('OTEL_')) delete process.env[key];
    const { startTelemetry } = await import('@cadenway/nest-common/telemetry');
    const telemetry = startTelemetry({ service: 'packaging-smoke-test' });
    assert.equal(telemetry.exporting, false);
    await telemetry.shutdown();
    console.log(JSON.stringify(exportsByEntry));
  `;
  writeFileSync(join(directory, 'runtime.mjs'), script);
  return JSON.parse(
    run(process.execPath, ['--import', '@cadenway/nest-common/register', 'runtime.mjs'], directory),
  );
}

test('packed Service Kit preserves the released public API and supports isolated optional peers', (context) => {
  const temporaryRoot = realpathSync(tmpdir());
  const scratch = mkdtempSync(join(temporaryRoot, 'cadenway-kit-packaging-'));
  context.after(() => {
    const resolved = realpathSync(scratch);
    assert.equal(dirname(resolved), temporaryRoot);
    assert.match(basename(resolved), /^cadenway-kit-packaging-/u);
    rmSync(resolved, { recursive: true, force: true });
  });

  const archives = pack(scratch);
  const minimalArchives = archives.filter(({ name }) => name !== '@cadenway/nest-jobs');
  const limited = join(scratch, 'minimal');
  const full = join(scratch, 'candidate');
  const reference = join(scratch, 'reference');
  const dependencies = (selected) =>
    Object.fromEntries(selected.map(({ name, archive }) => [name, archive]));
  const fullPeers = {
    ...peerVersions(archives, false),
    '@cadenway/contracts': contractsPeerVersion,
  };
  install(
    limited,
    { ...peerVersions(minimalArchives, true), ...dependencies(minimalArchives) },
    minimalEntries,
  );
  install(full, { ...fullPeers, ...dependencies(archives) }, entryPoints);
  install(reference, { ...fullPeers, ...baseline }, entryPoints);

  const runtimeEntries = [...entryPoints, ...preloadEntries];
  checkRuntime(limited, [...minimalEntries, ...preloadEntries], true);
  const releasedRuntime = checkRuntime(reference, runtimeEntries, false);
  const candidateRuntime = checkRuntime(full, runtimeEntries, false);
  for (const entry of runtimeEntries) {
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
