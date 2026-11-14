import { setTimeout as delay } from 'node:timers/promises';

import {
  Controller,
  Get,
  Inject,
  Optional,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  type HealthCheckResult,
  type HealthIndicatorResult,
} from '@nestjs/terminus';

import { SkipInternalToken } from '../auth/internal-token.guard.js';
import {
  DEFAULT_INDICATOR_TIMEOUT_MS,
  HEALTH_OPTIONS,
  type HealthIndicator,
  type HealthModuleOptions,
} from './health-indicators.js';

/**
 * Class HealthController
 *
 * @description
 * Serves the liveness and readiness routes probed by the container healthcheck.
 *
 * Internal to the package: applications import `HealthModule` and never this class, so its
 * constructor can change.
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
   * Receives the Terminus service and, when `HealthModule.forRoot` was used, the readiness
   * options.
   *
   * @param {HealthCheckService} health - Terminus health check service.
   * @param {HealthModuleOptions | undefined} options - Indicators and timeout; absent with the bare module.
   * @constructor
   */
  public constructor(
    private readonly health: HealthCheckService,
    @Optional() @Inject(HEALTH_OPTIONS) private readonly options?: HealthModuleOptions,
  ) {}
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
   * Runs the configured indicators, each within the timeout. All up: 200 with the Terminus body.
   * Any down: 503 with the same body shape, `status: 'error'`, the failing dependencies under
   * `error`. The body names dependencies and their state only, never an address or an error
   * text. Without indicators it answers 200 as soon as the application listens.
   *
   * @param {{ status(code: number): unknown }} response - Response, to set 503 while keeping the Terminus body.
   * @returns {Promise<HealthCheckResult>} The readiness result.
   */
  @Get('ready')
  @HealthCheck()
  public async ready(
    @Res({ passthrough: true }) response: { status(code: number): unknown },
  ): Promise<HealthCheckResult> {
    const timeoutMs: number = this.options?.timeoutMs ?? DEFAULT_INDICATOR_TIMEOUT_MS;
    try {
      return await this.health.check(
        (this.options?.indicators ?? []).map(
          (indicator: HealthIndicator) => (): Promise<HealthIndicatorResult> =>
            this.probe(indicator, timeoutMs),
        ),
      );
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        // Kept as the Terminus body rather than a problem: orchestrators and dashboards read it.
        response.status(503);
        return error.getResponse() as HealthCheckResult;
      }
      throw error;
    }
  }

  /**
   * Method probe
   *
   * @description
   * Runs one indicator within the timeout and reports it up or down.
   *
   * @param {HealthIndicator} indicator - Dependency to check.
   * @param {number} timeoutMs - Time the check may take, in milliseconds.
   * @returns {Promise<HealthIndicatorResult>} The state of the dependency, keyed by its name.
   */
  private async probe(
    indicator: HealthIndicator,
    timeoutMs: number,
  ): Promise<HealthIndicatorResult> {
    const cancel: AbortController = new AbortController();
    try {
      const outcome: 'up' | 'timeout' = await Promise.race([
        indicator.check().then((): 'up' => 'up'),
        delay(timeoutMs, 'timeout' as const, { signal: cancel.signal }),
      ]);
      return outcome === 'up'
        ? { [indicator.name]: { status: 'up' } }
        : { [indicator.name]: { status: 'down', message: 'timeout' } };
    } catch {
      return { [indicator.name]: { status: 'down', message: 'unreachable' } };
    } finally {
      cancel.abort();
    }
  }
  // #endregion
}
