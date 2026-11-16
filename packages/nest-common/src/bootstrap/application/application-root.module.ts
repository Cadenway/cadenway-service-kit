import { Module } from '@nestjs/common';

import { TelemetryShutdownModule } from './telemetry-shutdown.module.js';

/**
 * Class ApplicationRootModule
 *
 * @description
 * Root module `createApplication` wraps around the module of the application. Internal to the
 * package: it only anchors the shared providers.
 */
@Module({ imports: [TelemetryShutdownModule] })
export class ApplicationRootModule {}
