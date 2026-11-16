import { setTimeout as sleep } from 'node:timers/promises';

import type { BamEntry, BamStatusSummary, PgBoss } from 'pg-boss';

/**
 * Constant MIGRATION_POLL_INTERVAL_MS
 *
 * @description
 * Pause between two readings of the pending index builds, in milliseconds.
 *
 * @type {number}
 */
const MIGRATION_POLL_INTERVAL_MS: number = 1_000;

/**
 * Function waitForIndexBuilds
 *
 * @description
 * Waits until pg-boss has run every index build a schema migration queued.
 *
 * A migration creates its indexes in the background, one `CREATE INDEX CONCURRENTLY` at a time, and
 * only an instance allowed to migrate runs them. The runtime is not, so they must finish here. A
 * failed build is retried by pg-boss; the wait only ends when none is left or the time is up. A
 * fresh install queues none.
 *
 * @param {PgBoss} boss - Started pg-boss instance of the migrator role.
 * @param {string} schema - Schema name, used in the error message.
 * @param {number} timeoutMs - Time the builds get to finish, in milliseconds.
 * @returns {Promise<void>} Resolves once no build is pending, running or failed.
 * @throws {Error} When builds are still unfinished after the timeout.
 */
export async function waitForIndexBuilds(
  boss: PgBoss,
  schema: string,
  timeoutMs: number,
): Promise<void> {
  const deadline: number = Date.now() + timeoutMs;
  for (;;) {
    const statuses: BamStatusSummary[] = await boss.getBamStatus();
    const unfinished: number = statuses
      .filter((status: BamStatusSummary): boolean => status.status !== 'completed')
      .reduce((total: number, status: BamStatusSummary): number => total + status.count, 0);
    if (unfinished === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      const entries: BamEntry[] = await boss.getBamEntries();
      const details: string = entries
        .filter((entry: BamEntry): boolean => entry.status !== 'completed')
        .map((entry: BamEntry): string => `${entry.name} (${entry.status}): ${entry.error ?? '-'}`)
        .join('; ');
      throw new Error(
        `${String(unfinished)} index build(s) of schema "${schema}" did not finish in ${String(timeoutMs)} ms: ${details}. Run the provisioning again.`,
      );
    }
    await sleep(MIGRATION_POLL_INTERVAL_MS);
  }
}
