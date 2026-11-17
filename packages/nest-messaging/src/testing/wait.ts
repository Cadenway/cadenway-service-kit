/**
 * Function delay
 *
 * @description
 * Waits for a duration.
 *
 * @param {number} ms - Duration in milliseconds.
 * @returns {Promise<void>} Resolves after the duration.
 */
export async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve: () => void) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Function waitFor
 *
 * @description
 * Polls a condition until it holds, for the asynchronous effects of a spec: a delivery, a dead
 * letter, a row marked sent.
 *
 * @param {() => boolean | Promise<boolean>} condition - Condition to wait for.
 * @param {number} timeoutMs - How long to wait, in milliseconds; defaults to 15000.
 * @returns {Promise<void>} Resolves once the condition holds.
 * @throws {Error} When the condition does not hold in time.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number = 15_000,
): Promise<void> {
  const deadline: number = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`Condition not met within ${String(timeoutMs)} ms.`);
    }
    await delay(25);
  }
}

/** Lets a spec hold work at an exact point and settle it after observing another action. */
interface Deferred<TResult> {
  // #region Properties
  /** Work held until the spec settles the gate. */
  readonly promise: Promise<TResult>;

  /** Releases the gate successfully. */
  readonly resolve: (value: TResult) => void;

  /** Releases the gate with a failure. */
  readonly reject: (reason: unknown) => void;
  // #endregion
}

/** Creates a gate that a spec can resolve or reject explicitly. */
export function deferred<TResult>(): Deferred<TResult> {
  let resolve: (value: TResult) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<TResult>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
