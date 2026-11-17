import type { HealthIndicator } from './health-indicators.js';

/**
 * Type ProbeOutcome
 *
 * @description
 * The outcome of a readiness check, including the request's waiting limit.
 *
 * @type {'up' | 'unreachable' | 'timeout'}
 */
type ProbeOutcome = 'up' | 'unreachable' | 'timeout';

/**
 * Type ProbeWaiters
 *
 * @description
 * Waiters on one underlying driver operation.
 *
 * @type {Set<(outcome: ProbeOutcome) => void>}
 */
type ProbeWaiters = Set<(outcome: ProbeOutcome) => void>;

/**
 * Class ReadinessProbes
 *
 * @description
 * Keeps one driver operation per indicator until it actually settles.
 */
export class ReadinessProbes {
  // #region Properties
  /**
   * Property pending
   *
   * @description
   * In-flight operations keyed by the configured indicator instance.
   *
   * @type {WeakMap<HealthIndicator, ProbeWaiters>}
   * @readonly
   */
  private readonly pending = new WeakMap<HealthIndicator, ProbeWaiters>();
  // #endregion

  // #region Methods
  /**
   * Method wait
   *
   * @description
   * Waits for the indicator within this readiness request's timeout.
   *
   * @param {HealthIndicator} indicator - Configured readiness dependency to probe.
   * @param {number} timeoutMs - Maximum time this request waits for the probe, in milliseconds.
   * @returns {Promise<ProbeOutcome>} The driver outcome, or a timeout limited to this caller.
   */
  public wait(indicator: HealthIndicator, timeoutMs: number): Promise<ProbeOutcome> {
    const waiters: ProbeWaiters = this.pending.get(indicator) ?? this.start(indicator);
    return new Promise((resolve) => {
      const complete: (outcome: ProbeOutcome) => void = (outcome) => {
        clearTimeout(timeout);
        waiters.delete(complete);
        resolve(outcome);
      };
      const timeout: NodeJS.Timeout = setTimeout(complete, timeoutMs, 'timeout');
      waiters.add(complete);
    });
  }

  /**
   * Method start
   *
   * @description
   * Starts one shared driver operation and notifies remaining callers when it settles.
   *
   * @param {HealthIndicator} indicator - Configured readiness dependency to probe.
   * @returns {ProbeWaiters} The shared set of callbacks waiting for this driver operation.
   */
  private start(indicator: HealthIndicator): ProbeWaiters {
    const waiters: ProbeWaiters = new Set();
    this.pending.set(indicator, waiters);
    const complete: (outcome: ProbeOutcome) => void = (outcome) => {
      this.pending.delete(indicator);
      for (const waiter of waiters) {
        waiter(outcome);
      }
    };
    void Promise.resolve()
      .then(() => indicator.check())
      .then(
        () => {
          complete('up');
        },
        () => {
          complete('unreachable');
        },
      );
    return waiters;
  }
  // #endregion
}
