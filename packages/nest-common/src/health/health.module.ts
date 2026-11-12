import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health.controller.js';

/**
 * Adds the `GET /health/live` and `GET /health/ready` routes to a service or a gateway.
 *
 * Import the class as is: it takes no option. Both routes answer 200 with the Terminus body
 * (`{ status: 'ok', info: {}, error: {}, details: {} }`); readiness checks no dependency yet.
 *
 * The module is the only public entry of the health feature. Dependency indicators are meant to
 * arrive behind an option whose default keeps this behavior, so importing the bare class stays
 * valid.
 */
@Module({ imports: [TerminusModule], controllers: [HealthController] })
export class HealthModule {}
