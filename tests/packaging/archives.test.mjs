import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
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

// Optional interface properties and trailing constructor parameters added since the baseline.
// Each export must otherwise match its release. Clear an entry when the baseline includes it.
const addedMembers = {
  '@cadenway/nest-jobs#JobQueueDeclaration': ['organizationConcurrency'],
  '@cadenway/nest-jobs/provisioning#JobQueueDeclaration': ['organizationConcurrency'],
  '@cadenway/nest-jobs/runtime#JobQueueDeclaration': ['organizationConcurrency'],
  '@cadenway/nest-jobs#JobEnqueueOptions': ['startAfter'],
  '@cadenway/nest-jobs/runtime#JobEnqueueOptions': ['startAfter'],
  '@cadenway/nest-common#CreateApplicationOptions': ['rawJsonPostPaths'],
  '@cadenway/nest-common#InternalHttpClientOptions': ['allowedUnavailableProblemCodes'],
  '@cadenway/nest-common#InternalRequestInit': ['streamTimeoutMs'],
  '@cadenway/nest-common/database#DatabaseConfig': ['DATABASE_TRANSACTION_MAX_ATTEMPTS'],
  '@cadenway/nest-common/database#DatabaseModuleOptions': ['transactionMaxAttempts'],
  '@cadenway/nest-common/database#IdempotentOptions': ['maxAttempts'],
  '@cadenway/nest-common/database#SystemTransactionRunner': ['maxAttempts'],
  '@cadenway/nest-common/database#TenantTransactionRunner': ['maxAttempts'],
  '@cadenway/nest-common/database#TransactionOptions': ['maxAttempts'],
  '@cadenway/nest-common/telemetry#TelemetryOptions': [
    'sensitiveHttpPathPrefixes',
    'redactRedisCommandArguments',
  ],
  '@cadenway/nest-messaging#EventSubscription': ['redelivery', 'transactionIsolationLevel'],
  '@cadenway/nest-messaging#MessagingModuleOptions': [
    'deadLetterAdvisories',
    'deadLetterPayloadDropEvents',
  ],
};

// The standalone consumer below checks the reviewed additive class methods directly.
const addedClassMethods = {
  '@cadenway/nest-messaging#MessagingConnection': [
    'isConsumerAdvisoryStreamClear',
    'watchAvailability',
  ],
  '@cadenway/nest-messaging#EventConsumers': ['areCaughtUp', 'readProgress'],
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
  appendFileSync(
    join(full, 'consumer.mts'),
    `
import type { CreateApplicationOptions } from '@cadenway/nest-common';
import { databaseConfigShape, type DatabaseConfig } from '@cadenway/nest-common/database';
import type { JobEnqueueOptions } from '@cadenway/nest-jobs';
import type { JobEnqueueOptions as RuntimeJobEnqueueOptions } from '@cadenway/nest-jobs/runtime';
import type { JobQueueDeclaration } from '@cadenway/nest-jobs/provisioning';
import type {
  DeadLetterAdvisoriesOptions,
  EventConsumers,
  EventStreamProgress,
  MessagingConnection,
  MessagingModuleOptions,
} from '@cadenway/nest-messaging';
import { z } from 'zod';

const schema = z.object({ ...databaseConfigShape, SERVICE_NAME: z.string() });
const parsed = schema.parse({
  DATABASE_URL: 'postgres://localhost/task',
  SERVICE_NAME: 'packaging-test',
});
const config: DatabaseConfig = parsed;
const attempts: number = parsed.DATABASE_TRANSACTION_MAX_ATTEMPTS;
const webhookOptions: CreateApplicationOptions = {
  service: 'webhook-test',
  rawJsonPostPaths: ['/v1/webhooks/sample'],
};
const enqueue: JobEnqueueOptions = { startAfter: new Date() };
const runtimeEnqueue: RuntimeJobEnqueueOptions = enqueue;
const groupedQueue: JobQueueDeclaration = { name: 'notifications', organizationConcurrency: 1 };
const durableAdvisories: DeadLetterAdvisoriesOptions = {
  stream: 'EVENTS_ADVISORIES',
  durable: 'notification-dead-letter-advisories-v1',
  servers: 'nats://localhost:4222',
};
const durableOptions: Pick<MessagingModuleOptions, 'deadLetterWorker' | 'deadLetterAdvisories'> = {
  deadLetterWorker: true,
  deadLetterAdvisories: durableAdvisories,
};
const privacyOptions: Pick<MessagingModuleOptions, 'deadLetterPayloadDropEvents'> = {
  deadLetterPayloadDropEvents: ['task.updated.v1'],
};
declare const messagingConnection: MessagingConnection;
declare const eventConsumers: EventConsumers;
const stopWatching: () => void = messagingConnection.watchAvailability((available: boolean) => {
  void available;
});
const caughtUp: Promise<boolean> = eventConsumers.areCaughtUp(['relay-test'], AbortSignal.timeout(1000));
const caughtUpWithoutSignal: Promise<boolean> = eventConsumers.areCaughtUp(['relay-test']);
const progress: Promise<EventStreamProgress | undefined> = eventConsumers.readProgress(
  ['relay-test'],
  AbortSignal.timeout(1000),
);
const progressWithoutSignal: Promise<EventStreamProgress | undefined> = eventConsumers.readProgress([
  'relay-test',
]);
const advisoryClear: Promise<boolean> = messagingConnection.isConsumerAdvisoryStreamClear(
  'TEST_ADVISORIES',
  'EVENTS',
  ['test__relay'],
  AbortSignal.timeout(1000),
);
void [config, attempts, webhookOptions, runtimeEnqueue, groupedQueue, durableOptions, privacyOptions, stopWatching, caughtUp, caughtUpWithoutSignal, progress, progressWithoutSignal, advisoryClear];
`,
  );
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
  const candidateApi = readPublicApi(full, entryPoints, addedMembers, addedClassMethods);
  const differences = [];
  for (const [entry, signatures] of readPublicApi(reference, entryPoints)) {
    for (const [name, declarations] of signatures) {
      const candidate = candidateApi.get(entry)?.get(name);
      const exportName = `${entry}#${name}`;
      // The installed consumer above verifies that the shape still composes with Zod and keeps
      // every parsed key present. A hand-built DatabaseConfig can still omit the retry setting.
      const expected =
        exportName === '@cadenway/nest-common/database#databaseConfigShape'
          ? declarations.map((declaration) =>
              declaration.replace(
                'ConfigShape<DatabaseConfig>',
                'ConfigShape<Required<DatabaseConfig>>',
              ),
            )
          : declarations;
      if (!isDeepStrictEqual(candidate, expected)) {
        differences.push({ export: exportName, expected, candidate });
      }
    }
  }
  assert.deepEqual(differences, []);
});
