import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, type HealthCheckResult } from '@nestjs/terminus';

import { SkipInternalToken } from '../auth/internal-token.guard.js';

/**
 * Class HealthController
 *
 * @description
 * Serves the liveness and readiness routes probed by the container healthcheck.
 *
 * Internal to the package: applications import `HealthModule` and never this class, so its
 * constructor can change when readiness gets dependency indicators.
 *
 * The probes carry no internal token: the routes are exempt from the internal-token guard.
 */
@Controller('health')
@SkipInternalToken()
export class HealthController {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Receives the Terminus service used to execute health checks.
   *
   * @param {HealthCheckService} health - Terminus health check service.
   * @constructor
   */
  public constructor(private readonly health: HealthCheckService) {}
  // #endregion

  // #region Methods
  /**
   * Method live
   *
   * @description
   * Tells the orchestrator that the process is running.
   *
   * Runs no indicator on purpose: an unreachable dependency must not get a healthy process
   * restarted. Answers 200 with the Terminus body, whose `status` is `ok`.
   *
   * @returns {Promise<HealthCheckResult>} The liveness result.
   */
  @Get('live')
  @HealthCheck()
  public live(): Promise<HealthCheckResult> {
    return this.health.check([]);
  }

  /**
   * Method ready
   *
   * @description
   * Tells the orchestrator that the application accepts requests.
   *
   * Runs no dependency indicator yet, so it answers 200 with the Terminus body as soon as the
   * application listens. It goes through Terminus already so that the body keeps the same shape
   * when indicators are added.
   *
   * @returns {Promise<HealthCheckResult>} The readiness result.
   */
  @Get('ready')
  @HealthCheck()
  public ready(): Promise<HealthCheckResult> {
    return this.health.check([]);
  }
  // #endregion
}
