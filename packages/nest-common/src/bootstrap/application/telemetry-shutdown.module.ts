import { Global, Module } from '@nestjs/common';

import { TelemetryShutdown } from './telemetry-shutdown.js';

/**
 * Class TelemetryShutdownModule
 *
 * @description
 * Hosts the telemetry flush in a global module. NestJS runs the shutdown hooks of the root
 * module first and those of global modules last: declared here, the flush runs after the
 * application has closed its own resources, such as the database pool.
 */
@Global()
@Module({ providers: [TelemetryShutdown] })
export class TelemetryShutdownModule {}
