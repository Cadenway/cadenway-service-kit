import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import {
  getOrganizationContext,
  requireOrganizationId,
  runWithOrganizationContext,
  type OrganizationContext,
} from './organization-context.js';

/**
 * Function contextOf
 *
 * @description
 * Builds the context of a system actor working in one organization.
 *
 * @param {string | null} organizationId - Organization of the work.
 * @returns {OrganizationContext} The context.
 */
function contextOf(organizationId: string | null): OrganizationContext {
  return { organizationId, actor: { type: 'system', id: null }, role: null, scopes: [] };
}

describe('organization context', () => {
  it('is absent outside any work', () => {
    expect(getOrganizationContext()).toBeUndefined();
    expect(() => requireOrganizationId()).toThrow(/No organization in the current context/u);
  });

  it('follows the asynchronous work it was opened for and ends with it', async () => {
    const seen: string = await runWithOrganizationContext(contextOf('org-a'), async () => {
      await delay(5);
      return requireOrganizationId();
    });

    expect(seen).toBe('org-a');
    expect(getOrganizationContext()).toBeUndefined();
  });

  it('keeps overlapping works apart', async () => {
    const seen: string[] = await Promise.all(
      ['org-a', 'org-b'].map((organizationId: string) =>
        runWithOrganizationContext(contextOf(organizationId), async () => {
          await delay(organizationId === 'org-a' ? 10 : 1);
          return requireOrganizationId();
        }),
      ),
    );

    expect(seen).toEqual(['org-a', 'org-b']);
  });

  it('refuses to name an organization when the context carries none', () => {
    runWithOrganizationContext(contextOf(null), () => {
      expect(getOrganizationContext()?.organizationId).toBeNull();
      expect(() => requireOrganizationId()).toThrow(/No organization in the current context/u);
    });
  });

  it('hands out a frozen copy', () => {
    const context: OrganizationContext = contextOf('org-a');

    runWithOrganizationContext(context, () => {
      expect(getOrganizationContext()).not.toBe(context);
      expect(Object.isFrozen(getOrganizationContext())).toBe(true);
    });
  });
});
