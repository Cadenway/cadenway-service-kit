import type { HealthIndicator } from './health-indicators.js';

/** The outcome of a readiness check, including the request's waiting limit. */
type ProbeOutcome = 'up' | 'unreachable' | 'timeout';

/** Waiters on one underlying driver operation. */
type ProbeWaiters = Set<(outcome: ProbeOutcome) => void>;

/** Keeps one driver operation per indicator until it actually settles. */
export class ReadinessProbes {
  // #region Properties
  /** In-flight operations keyed by the configured indicator instance. */
  private readonly pending = new WeakMap<HealthIndicator, ProbeWaiters>();
  // #endregion

  // #region Methods
  /** Waits for the indicator within this readiness request's timeout. */
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
