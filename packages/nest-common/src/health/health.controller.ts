import { setTimeout as delay } from 'node:timers/promises';

import {
  Controller,
  Get,
  Inject,
  Logger,
  Optional,
  Res,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  type HealthCheckResult,
  type HealthIndicatorResult,
} from '@nestjs/terminus';

import { SkipInternalToken } from '../auth/internal-token/internal-token.guard.js';
import {
  DEFAULT_INDICATOR_TIMEOUT_MS,
  HEALTH_OPTIONS,
  type HealthIndicator,
  type HealthModuleOptions,
} from './health-indicators.js';

/**
 * Function shuttingDownResult
 *
 * @description
 * Builds the readiness body answered once the application is stopping: the Terminus shape, with
 * the pseudo-dependency `shutdown` down.
 *
 * @returns {HealthCheckResult} The body of the 503 answer.
 */
function shuttingDownResult(): HealthCheckResult {
  return {
    status: 'error',
    info: {},
    error: { shutdown: { status: 'down', message: 'shutting down' } },
    details: { shutdown: { status: 'down', message: 'shutting down' } },
  };
}

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
 *
 * Once the application starts shutting down, readiness answers 503 while liveness keeps
 * answering 200: `onModuleDestroy` is the first hook NestJS runs on `app.close()` (or on the
 * signal handled by the shutdown hooks), before the listener closes. It then holds the shutdown
 * for `shutdownDelayMs`, so a proxy that probes readiness stops routing to the instance while it
 * still serves.
 *
 * Readiness writes one line per change of state, not one per failed probe: a `warn` when it goes
 * down, naming the failing dependencies and `unreachable` or `timeout`, again when the set of
 * failing dependencies changes, and a `log` when it is back up.
 */
@Controller('health')
@SkipInternalToken()
export class HealthController implements OnModuleDestroy {
  // #region Properties
  /**
   * Property logger
   *
   * @description
   * Logger of the readiness state changes.
   *
   * @type {Logger}
   * @readonly
   */
  private readonly logger: Logger = new Logger('Health');

  /**
   * Property shuttingDown
   *
   * @description
   * Whether the application has started shutting down; readiness then answers 503.
   *
   * @type {boolean}
   */
  private shuttingDown: boolean = false;

  /**
   * Property lastFailure
   *
   * @description
   * Failing dependencies of the last readiness check, serialized, or `undefined` when it was up.
   * Compared with the next result to log changes only.
   *
   * @type {string | undefined}
   */
  private lastFailure: string | undefined = undefined;
  // #endregion

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
   * text. Without indicators it answers 200 as soon as the application listens. Once the
   * application is shutting down it answers 503 with the dependency `shutdown` down, without
   * running the indicators.
   *
   * @param {{ status(code: number): unknown }} response - Response, to set 503 while keeping the Terminus body.
   * @returns {Promise<HealthCheckResult>} The readiness result.
   */
  @Get('ready')
  @HealthCheck()
  public async ready(
    @Res({ passthrough: true }) response: { status(code: number): unknown },
  ): Promise<HealthCheckResult> {
    if (this.shuttingDown) {
      response.status(503);
      return shuttingDownResult();
    }
    const timeoutMs: number = this.options?.timeoutMs ?? DEFAULT_INDICATOR_TIMEOUT_MS;
    try {
      const result: HealthCheckResult = await this.health.check(
        (this.options?.indicators ?? []).map(
          (indicator: HealthIndicator) => (): Promise<HealthIndicatorResult> =>
            this.probe(indicator, timeoutMs),
        ),
      );
      this.recordOutcome(undefined);
      return result;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        // Kept as the Terminus body rather than a problem: orchestrators and dashboards read it.
        response.status(503);
        const result: HealthCheckResult = error.getResponse() as HealthCheckResult;
        this.recordOutcome(result.error ?? {});
        return result;
      }
      throw error;
    }
  }

  /**
   * Method onModuleDestroy
   *
   * @description
   * Turns readiness to 503 as soon as the application starts shutting down, then waits
   * `shutdownDelayMs` (0 by default: the shutdown is not slowed) before letting it go on to close
   * the listener.
   *
   * @returns {Promise<void>} Resolves once the delay has passed.
   */
  public async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    const delayMs: number = this.options?.shutdownDelayMs ?? 0;
    if (delayMs > 0) {
      await delay(delayMs);
    }
  }

  /**
   * Method recordOutcome
   *
   * @description
   * Logs a change of the readiness state: a warning when it goes down or when the failing
   * dependencies change, an info line when it is back up, nothing when the result repeats.
   *
   * @param {Partial<HealthIndicatorResult> | undefined} failing - Failing dependencies of the check, or `undefined` when all are up.
   * @returns {void}
   */
  private recordOutcome(failing: Partial<HealthIndicatorResult> | undefined): void {
    if (failing === undefined) {
      if (this.lastFailure !== undefined) {
        this.lastFailure = undefined;
        this.logger.log('readiness recovered');
      }
      return;
    }
    const dependencies: Record<string, string> = Object.fromEntries(
      Object.entries(failing).map(
        ([name, state]: [string, Readonly<Record<string, unknown>> | undefined]) => [
          name,
          typeof state?.message === 'string' ? state.message : 'down',
        ],
      ),
    );
    const signature: string = JSON.stringify(dependencies);
    if (signature !== this.lastFailure) {
      this.lastFailure = signature;
      this.logger.warn({ dependencies }, 'readiness down');
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
