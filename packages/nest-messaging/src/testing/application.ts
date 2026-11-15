import type { ModuleMetadata } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { context, propagation } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

import type { MessagingModuleOptions } from '../messaging-options.js';
import type { TestNats } from './nats.js';

/**
 * Function startApplication
 *
 * @description
 * Builds and initializes a NestJS application made of the given modules, the way a service
 * starts: the bootstrap hooks run. Closing it runs the shutdown hooks. Logs are silenced: the
 * failure paths of the specs log errors on purpose.
 *
 * @param {NonNullable<ModuleMetadata['imports']>} imports - Modules of the application.
 * @param {NonNullable<ModuleMetadata['providers']>} providers - Extra providers of the application.
 * @returns {Promise<TestingModule>} The running application.
 */
export async function startApplication(
  imports: NonNullable<ModuleMetadata['imports']>,
  providers: NonNullable<ModuleMetadata['providers']> = [],
): Promise<TestingModule> {
  const application: TestingModule = await Test.createTestingModule({
    imports,
    providers,
  }).compile();
  application.useLogger(false);
  await application.init();
  return application;
}

/**
 * Function messagingOptions
 *
 * @description
 * Builds the options of `MessagingModule` for a disposable server: its address and credentials,
 * streams managed by the module, and whatever the spec overrides.
 *
 * @param {TestNats} nats - Disposable server.
 * @param {Partial<MessagingModuleOptions>} overrides - Options of the spec.
 * @returns {MessagingModuleOptions} The options.
 */
export function messagingOptions(
  nats: TestNats,
  overrides: Partial<MessagingModuleOptions> = {},
): MessagingModuleOptions {
  return {
    service: 'task-service',
    servers: nats.url,
    user: nats.user,
    password: nats.password,
    manageStreams: true,
    ...overrides,
  };
}

/**
 * Function isolatedNames
 *
 * @description
 * Gives a spec its own streams and subject prefixes on a shared server, so its messages never
 * reach the consumers of another spec.
 *
 * @param {string} suffix - Short name of the spec, made of letters and digits.
 * @returns {Pick<MessagingModuleOptions, 'eventsStream' | 'restrictedStream' | 'deadLetterStream' | 'eventSubjectPrefix' | 'restrictedSubjectPrefix' | 'deadLetterSubjectPrefix' | 'rebuildSubjectPrefix'>} Stream names and prefixes.
 */
export function isolatedNames(
  suffix: string,
): Pick<
  MessagingModuleOptions,
  | 'eventsStream'
  | 'restrictedStream'
  | 'deadLetterStream'
  | 'eventSubjectPrefix'
  | 'restrictedSubjectPrefix'
  | 'deadLetterSubjectPrefix'
  | 'rebuildSubjectPrefix'
> {
  return {
    eventsStream: `EVENTS_${suffix}`,
    restrictedStream: `EVENTS_RESTRICTED_${suffix}`,
    deadLetterStream: `EVENTS_DLQ_${suffix}`,
    eventSubjectPrefix: `evt-${suffix}`,
    restrictedSubjectPrefix: `restricted-${suffix}`,
    deadLetterSubjectPrefix: `dlq-${suffix}`,
    rebuildSubjectPrefix: `rebuild-${suffix}`,
  };
}

/**
 * Function enableTracePropagation
 *
 * @description
 * Registers the W3C propagator and a context manager, as the telemetry start-up of
 * `@cadenway/nest-common` does, without an SDK: spans are not recorded, but a trace context
 * travels through asynchronous work and through message headers.
 *
 * @returns {void}
 */
export function enableTracePropagation(): void {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
}

/**
 * Function disableTracePropagation
 *
 * @description
 * Removes what `enableTracePropagation` registered.
 *
 * @returns {void}
 */
export function disableTracePropagation(): void {
  propagation.disable();
  context.disable();
}
