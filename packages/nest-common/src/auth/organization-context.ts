import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Type InternalActorType
 *
 * @description
 * Who a request acts for. The first four are the actor types of the event contracts; `anonymous`
 * is a caller that is not signed in (sign-up, sign-in, the public intake form).
 *
 * @type {'user' | 'automation' | 'git' | 'system' | 'anonymous'}
 */
export type InternalActorType = 'user' | 'automation' | 'git' | 'system' | 'anonymous';

/**
 * Interface InternalActor
 *
 * @description
 * Actor of a request, as carried by the internal token.
 */
export interface InternalActor {
  // #region Properties
  /**
   * Property type
   *
   * @description
   * Kind of actor.
   *
   * @type {InternalActorType}
   * @readonly
   */
  readonly type: InternalActorType;

  /**
   * Property id
   *
   * @description
   * Id of the user, automation rule or Git installation. `null` for an anonymous actor, and for
   * the system when it has no finer identity.
   *
   * @type {string | null}
   * @readonly
   */
  readonly id: string | null;
  // #endregion
}

/**
 * Interface OrganizationContext
 *
 * @description
 * Who the current work is done for: the organization and the actor. On an HTTP request it is
 * derived from the verified internal token and from nothing else.
 */
export interface OrganizationContext {
  // #region Properties
  /**
   * Property organizationId
   *
   * @description
   * Organization the work belongs to, or `null` for work outside any organization.
   *
   * @type {string | null}
   * @readonly
   */
  readonly organizationId: string | null;

  /**
   * Property actor
   *
   * @description
   * Actor the work is done for.
   *
   * @type {InternalActor}
   * @readonly
   */
  readonly actor: InternalActor;

  /**
   * Property role
   *
   * @description
   * Member role of a user in the organization, or `null`.
   *
   * @type {string | null}
   * @readonly
   */
  readonly role: string | null;

  /**
   * Property scopes
   *
   * @description
   * Scopes granted to the caller, such as `tasks:read`.
   *
   * @type {readonly string[]}
   * @readonly
   */
  readonly scopes: readonly string[];
  // #endregion
}

/**
 * Constant storage
 *
 * @description
 * Carries the organization context along the asynchronous work of one request, event or job.
 *
 * @type {AsyncLocalStorage<OrganizationContext>}
 */
const storage: AsyncLocalStorage<OrganizationContext> =
  new AsyncLocalStorage<OrganizationContext>();

/**
 * Function getOrganizationContext
 *
 * @description
 * Returns the organization context of the current work.
 *
 * @returns {OrganizationContext | undefined} The context, or `undefined` outside any.
 */
export function getOrganizationContext(): OrganizationContext | undefined {
  return storage.getStore();
}

/**
 * Function requireOrganizationId
 *
 * @description
 * Returns the organization of the current work, for code that cannot run without one.
 *
 * @returns {string} The organization id.
 * @throws {Error} When there is no context or it carries no organization: a programming error, not a caller error.
 */
export function requireOrganizationId(): string {
  const organizationId: string | null | undefined = storage.getStore()?.organizationId;
  if (organizationId === undefined || organizationId === null) {
    throw new Error('No organization in the current context.');
  }
  return organizationId;
}

/**
 * Function runWithOrganizationContext
 *
 * @description
 * Runs work inside an organization context. Everything the work awaits sees the context.
 *
 * For trusted entry points only. On HTTP the kit calls it with the verified internal token and
 * an application never does. Elsewhere it is called with an identity the service itself
 * established: the envelope of an event validated against its contract, or a job the service
 * enqueued. Never build the context from a path, a query string or a request body.
 *
 * @param {OrganizationContext} context - Organization and actor of the work.
 * @param {() => TResult} work - Work to run inside the context.
 * @returns {TResult} What the work returns.
 */
export function runWithOrganizationContext<TResult>(
  context: OrganizationContext,
  work: () => TResult,
): TResult {
  return storage.run(Object.freeze({ ...context }), work);
}
