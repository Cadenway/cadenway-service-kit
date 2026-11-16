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
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const kitPackages = ['@cadenway/nest-common', '@cadenway/nest-messaging', '@cadenway/nest-jobs'];
const registry = 'https://npm.pkg.github.com';

export const legacyEntryPoints = [
  '@cadenway/nest-common',
  '@cadenway/nest-common/database',
  '@cadenway/nest-common/redis',
  '@cadenway/nest-common/telemetry',
  '@cadenway/nest-messaging',
  '@cadenway/nest-messaging/outbox',
  '@cadenway/nest-jobs',
];
export const entryPoints = [
  ...legacyEntryPoints,
  '@cadenway/nest-messaging/consumer/postgres',
  '@cadenway/nest-messaging/outbox/writer',
  '@cadenway/nest-messaging/outbox/relay',
  '@cadenway/nest-messaging/outbox/schema',
  '@cadenway/nest-jobs/runtime',
  '@cadenway/nest-jobs/provisioning',
];
const capabilityExports = {
  '@cadenway/nest-messaging/consumer/postgres': [
    'PostgresEventDeduplicationModule',
    'PostgresEventDeduplicator',
  ],
  '@cadenway/nest-messaging/outbox/writer': ['OutboxWriter', 'OutboxWriterModule'],
  '@cadenway/nest-messaging/outbox/relay': [
    'OutboxRelayModule',
    'LeasedOutboxRelay',
    'recoverExpiredOutboxLeases',
  ],
  '@cadenway/nest-messaging/outbox/schema': [
    'outboxEvents',
    'eventVersions',
    'processedEvents',
    'finishOutboxLeaseMigration',
  ],
  '@cadenway/nest-jobs/runtime': [
    'JobsRuntimeModule',
    'JobProducer',
    'JobWorkerRegistry',
    'JobScheduler',
  ],
  '@cadenway/nest-jobs/provisioning': ['provisionJobs'],
};
export const minimalEntries = [
  '@cadenway/nest-common',
  '@cadenway/nest-common/telemetry',
  '@cadenway/nest-messaging',
];
export const preloadEntries = ['@cadenway/nest-common/hook.mjs', '@cadenway/nest-common/register'];

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

export function registryPackage(name, version, directory) {
  const metadata = JSON.parse(
    pnpm(
      [
        'view',
        `${name}@${version}`,
        'dist.tarball',
        'peerDependenciesMeta',
        '--json',
        `--registry=${registry}`,
      ],
      directory,
    ),
  );
  const url = new URL(metadata['dist.tarball']);
  assert.equal(url.origin, registry);
  assert.equal(url.username + url.password + url.search + url.hash, '');
  assert.ok(url.pathname.startsWith(`/download/${name}/${version}/`));
  return { url: url.href, peerMetadata: metadata.peerDependenciesMeta };
}

function assertBuildInventory(name, files) {
  const packageDirectory = join(repository, 'packages', basename(name));
  const project = ts.getParsedCommandLineOfConfigFile(
    join(packageDirectory, 'tsconfig.build.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    },
  );
  assert.ok(project && project.errors.length === 0, `Invalid build configuration for ${name}`);
  const expected = project.fileNames
    .flatMap((file) => ts.getOutputFileNames(project, file, !ts.sys.useCaseSensitiveFileNames))
    .map((file) => relative(packageDirectory, file).replaceAll('\\', '/'))
    .sort();
  const actual = files
    .map(({ path }) => path)
    .filter((path) => path.startsWith('dist/'))
    .sort();
  assert.deepEqual(actual, expected, `Build output differs for ${name}. Run pnpm build first.`);
}

export function pack(destination) {
  return kitPackages.map((name) => {
    const packed = JSON.parse(
      pnpm(['--filter', name, 'pack', '--pack-destination', destination, '--json'], repository),
    );
    const result = Array.isArray(packed) ? packed[0] : packed;
    assert.equal(result.name, name);
    assertBuildInventory(name, result.files);
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

export function peerVersions(archives, minimal) {
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

export function install(directory, dependencies, imports) {
  mkdirSync(directory);
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ private: true, type: 'module', dependencies }),
  );
  writeFileSync(join(directory, 'pnpm-workspace.yaml'), 'autoInstallPeers: false\n');
  writeFileSync(join(directory, '.npmrc'), `@cadenway:registry=${registry}\n`);
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

export function checkRuntime(directory, entries, minimal) {
  const script = `
    import assert from 'node:assert/strict';
    import 'reflect-metadata';
    const entries = ${JSON.stringify(entries)};
    const requiredExports = ${JSON.stringify(capabilityExports)};
    const exportsByEntry = {};
    for (const entry of entries) exportsByEntry[entry] = Object.keys(await import(entry)).sort();
    for (const [entry, names] of Object.entries(requiredExports)) {
      if (!entries.includes(entry)) continue;
      for (const name of names) assert.ok(exportsByEntry[entry].includes(name), entry + '#' + name);
    }
    const writer = exportsByEntry['@cadenway/nest-messaging/outbox/writer'];
    if (writer) assert.deepEqual(writer, ['OutboxWriter', 'OutboxWriterModule']);
    if (entries.includes('@cadenway/nest-messaging/consumer/postgres')) {
      const postgres = await import('@cadenway/nest-messaging/consumer/postgres');
      const legacy = await import('@cadenway/nest-messaging/outbox');
      assert.equal(postgres.PostgresEventDeduplicator, legacy.PostgresEventDeduplicator);
    }
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

export function createScratch(context) {
  const temporaryRoot = realpathSync(tmpdir());
  const scratch = mkdtempSync(join(temporaryRoot, 'cadenway-kit-packaging-'));
  context.after(() => {
    const resolved = realpathSync(scratch);
    assert.equal(dirname(resolved), temporaryRoot);
    assert.match(basename(resolved), /^cadenway-kit-packaging-/u);
    rmSync(resolved, { recursive: true, force: true });
  });
  return scratch;
}
