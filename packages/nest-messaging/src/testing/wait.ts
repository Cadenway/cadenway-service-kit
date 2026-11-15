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
