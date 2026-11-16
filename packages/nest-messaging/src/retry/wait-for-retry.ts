/**
 * Function waitForRetry
 *
 * @description
 * Delays the next attempt or stops waiting when the application shuts down. The timeout and the
 * abort listener are released whichever ends the wait.
 *
 * @param {number} delayMs - Delay between attempts, in milliseconds.
 * @param {AbortSignal} stop - Signal aborted during application shutdown.
 * @returns {Promise<void>} Resolves when the delay ends or shutdown begins.
 */
export function waitForRetry(delayMs: number, stop: AbortSignal): Promise<void> {
  if (stop.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve: () => void) => {
    const timer: NodeJS.Timeout = setTimeout(done, delayMs);
    stop.addEventListener('abort', done, { once: true });

    /**
     * Function done
     *
     * @description
     * Disposes of the wait before resolving.
     *
     * @returns {void}
     */
    function done(): void {
      clearTimeout(timer);
      stop.removeEventListener('abort', done);
      resolve();
    }
  });
}
