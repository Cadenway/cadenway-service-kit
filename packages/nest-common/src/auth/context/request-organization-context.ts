import type { InternalPrincipal } from './internal-principal.js';
import { assertConsistentContext } from './organization-claims.js';
import type { OrganizationContext } from './organization-context.js';

/**
 * Constant PRINCIPAL_PROPERTY
 *
 * @description
 * Request property holding the verified principal.
 *
 * @type {'internalPrincipal'}
 */
const PRINCIPAL_PROPERTY: 'internalPrincipal' = 'internalPrincipal';

/**
 * Constant ATTACHED_CONTEXT
 *
 * @description
 * Request property holding the organization context attached by `setRequestOrganizationContext`.
 * A symbol private to this module: nothing else, and no request data, can set it.
 *
 * @type {symbol}
 */
const ATTACHED_CONTEXT: unique symbol = Symbol('cadenway.request-organization-context');

/**
 * Function setVerifiedInternalPrincipal
 *
 * @description
 * Attaches the principal accepted by the internal token guard.
 *
 * @param {object} request - Incoming request.
 * @param {InternalPrincipal} principal - Identity verified and accepted by the guard.
 * @returns {void}
 */
export function setVerifiedInternalPrincipal(request: object, principal: InternalPrincipal): void {
  const holder: { [PRINCIPAL_PROPERTY]?: InternalPrincipal } = request;
  holder[PRINCIPAL_PROPERTY] = principal;
}

/**
 * Function principalOf
 *
 * @description
 * Reads the principal the guard verified for a request.
 *
 * @param {object} request - Incoming request.
 * @returns {InternalPrincipal | undefined} The verified principal, or `undefined` on a route without a token.
 */
export function principalOf(request: object): InternalPrincipal | undefined {
  return (request as { [PRINCIPAL_PROPERTY]?: InternalPrincipal })[PRINCIPAL_PROPERTY];
}

/**
 * Function setRequestOrganizationContext
 *
 * @description
 * Sets the organization context of an HTTP request whose caller was verified by the application
 * itself rather than by the internal token: a public gateway, after it introspected a session or
 * checked an API token. `OrganizationContextInterceptor` then runs the handler inside it, so
 * `getOrganizationContext()`, the transaction runners, `InternalHttpClient` and the logs read it
 * as they read the context of an internal token.
 *
 * Call it only from the code that verified the caller, usually its guard, and only with what that
 * verification returned: never with a value read from the request (path, query string, body or
 * headers). Besides the internal token, it is the only sanctioned way to give an HTTP request an
 * identity; `runWithOrganizationContext` is not one.
 *
 * A request has one source of identity: it throws when the request already carries an attached
 * context or a principal verified by `InternalTokenGuard`. It also throws for a context the
 * internal token could not carry (an organization id that is not a UUID, an anonymous actor with
 * an id, an organization, a role or scopes, an identified actor without an id).
 *
 * @param {object} request - Incoming request, as handed to the guard.
 * @param {OrganizationContext} context - Organization, actor, member role and scopes established by the verification.
 * @returns {void}
 * @throws {Error} When the request already has an identity or the context is inconsistent: a programming error.
 */
export function setRequestOrganizationContext(request: object, context: OrganizationContext): void {
  const holder: { [ATTACHED_CONTEXT]?: OrganizationContext } = request;
  if (principalOf(request) !== undefined) {
    throw new Error(
      'setRequestOrganizationContext: the request carries a verified internal token; it has its identity already.',
    );
  }
  if (holder[ATTACHED_CONTEXT] !== undefined) {
    throw new Error(
      'setRequestOrganizationContext: the request already carries an organization context.',
    );
  }
  assertConsistentContext(context);
  holder[ATTACHED_CONTEXT] = Object.freeze({
    organizationId: context.organizationId,
    actor: Object.freeze({ type: context.actor.type, id: context.actor.id }),
    role: context.role,
    scopes: Object.freeze([...context.scopes]),
  });
}

/**
 * Function requestOrganizationContextOf
 *
 * @description
 * Reads the identity of a request from its one source: the principal verified by
 * `InternalTokenGuard`, otherwise the context attached by `setRequestOrganizationContext`.
 * Internal to the package; applications read `getOrganizationContext()`.
 *
 * @param {object} request - Incoming request.
 * @returns {OrganizationContext | undefined} The organization context of the request, or `undefined` when it has none.
 */
export function requestOrganizationContextOf(request: object): OrganizationContext | undefined {
  const principal: InternalPrincipal | undefined = principalOf(request);
  if (principal !== undefined) {
    return {
      organizationId: principal.organizationId,
      actor: principal.actor,
      role: principal.role,
      scopes: principal.scopes,
    };
  }
  return (request as { [ATTACHED_CONTEXT]?: OrganizationContext })[ATTACHED_CONTEXT];
}
