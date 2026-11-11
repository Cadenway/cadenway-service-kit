import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, type HealthCheckResult } from '@nestjs/terminus';

/**
 * Serves the liveness and readiness routes probed by the container healthcheck.
 *
 * Internal to the package: applications import `HealthModule` and never this class, so its
 * constructor can change when readiness gets dependency indicators.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthCheckService) {}

  /**
   * Tells the orchestrator that the process is running.
   *
   * Runs no indicator on purpose: an unreachable dependency must not get a healthy process
   * restarted. Answers 200 with the Terminus body, whose `status` is `ok`.
   */
  @Get('live')
  @HealthCheck()
  live(): Promise<HealthCheckResult> {
    return this.health.check([]);
  }

  /**
   * Tells the orchestrator that the application accepts requests.
   *
   * Runs no dependency indicator yet, so it answers 200 with the Terminus body as soon as the
   * application listens. It goes through Terminus already so that the body keeps the same shape
   * when indicators are added.
   */
  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([]);
  }
}
