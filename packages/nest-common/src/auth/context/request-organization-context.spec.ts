import { describe, expect, it } from 'vitest';

import type { InternalPrincipal } from './internal-principal.js';
import type { OrganizationContext } from './organization-context.js';
import {
  principalOf,
  requestOrganizationContextOf,
  setRequestOrganizationContext,
  setVerifiedInternalPrincipal,
} from './request-organization-context.js';

/**
 * Constant verifiedContext
 *
 * @description
 * Identity returned after verifying a request outside the internal token guard.
 *
 * @type {OrganizationContext}
 */
const verifiedContext: OrganizationContext = {
  organizationId: '0193a1f0-0000-7000-8000-00000000000a',
  actor: { type: 'user', id: 'user-verified' },
  role: 'member',
  scopes: ['tasks:write'],
};

describe('setRequestOrganizationContext', () => {
  it('attaches a frozen copy that the request identity then reads', () => {
    const incoming: object = {};
    const scopes: string[] = ['tasks:write'];

    setRequestOrganizationContext(incoming, { ...verifiedContext, scopes });
    scopes.push('tasks:delete');
    const attached: OrganizationContext | undefined = requestOrganizationContextOf(incoming);

    expect(attached).toEqual(verifiedContext);
    expect(Object.isFrozen(attached)).toBe(true);
    expect(Object.isFrozen(attached?.actor)).toBe(true);
    expect(Object.isFrozen(attached?.scopes)).toBe(true);
    expect(Object.keys(incoming)).toEqual([]);
  });

  it('reads the verified principal before a context attached earlier', () => {
    const incoming: object = {};
    const principal: InternalPrincipal = {
      ...verifiedContext,
      organizationId: null,
      issuer: 'api-gateway',
      audience: 'task-service',
      traceId: null,
    };
    setRequestOrganizationContext(incoming, verifiedContext);
    setVerifiedInternalPrincipal(incoming, principal);

    expect(principalOf(incoming)).toBe(principal);
    expect(requestOrganizationContextOf(incoming)).toEqual({
      organizationId: null,
      actor: verifiedContext.actor,
      role: verifiedContext.role,
      scopes: verifiedContext.scopes,
    });
  });

  it('refuses a second context on the same request', () => {
    const incoming: object = {};
    setRequestOrganizationContext(incoming, verifiedContext);

    expect(() => {
      setRequestOrganizationContext(incoming, { ...verifiedContext, organizationId: null });
    }).toThrow(/already carries an organization context/u);
    expect(requestOrganizationContextOf(incoming)?.organizationId).toBe(
      verifiedContext.organizationId,
    );
  });

  it('refuses a context an internal token could not carry', () => {
    expect(() => {
      setRequestOrganizationContext({}, { ...verifiedContext, organizationId: 'atelier-nord' });
    }).toThrow(/Inconsistent organization context/u);
    expect(() => {
      setRequestOrganizationContext(
        {},
        { ...verifiedContext, actor: { type: 'anonymous', id: null } },
      );
    }).toThrow(/Inconsistent organization context/u);
    expect(() => {
      setRequestOrganizationContext({}, { ...verifiedContext, actor: { type: 'user', id: null } });
    }).toThrow(/Inconsistent organization context/u);
  });

  it('gives a request without identity no context', () => {
    expect(requestOrganizationContextOf({})).toBeUndefined();
  });
});
