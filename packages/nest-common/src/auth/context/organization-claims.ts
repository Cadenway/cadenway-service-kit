import { z } from 'zod';

import type { InternalActor, OrganizationContext } from './organization-context.js';

/**
 * Interface TokenClaimSet
 *
 * @description
 * Private claims of the internal token, as written in the JWT payload.
 */
export interface TokenClaimSet {
  // #region Properties
  /**
   * Property actor
   *
   * @description
   * Actor the call is made for.
   *
   * @type {InternalActor}
   * @readonly
   */
  readonly actor: InternalActor;

  /**
   * Property organization_id
   *
   * @description
   * Organization the call is made in, or `null`.
   *
   * @type {string | null}
   * @readonly
   */
  readonly organization_id: string | null;

  /**
   * Property role
   *
   * @description
   * Member role of the user, or `null`.
   *
   * @type {string | null}
   * @readonly
   */
  readonly role: string | null;

  /**
   * Property scopes
   *
   * @description
   * Scopes granted to the caller.
   *
   * @type {string[]}
   * @readonly
   */
  readonly scopes: string[];

  /**
   * Property trace_id
   *
   * @description
   * Trace id stated by the issuer.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly trace_id?: string | undefined;
  // #endregion
}

/**
 * Constant claimSetSchema
 *
 * @description
 * Shape and consistency of the private claims: an identified actor has an id, an anonymous one
 * has no id, no organization, no role and no scope.
 *
 * @type {z.ZodType<TokenClaimSet>}
 */
export const claimSetSchema: z.ZodType<TokenClaimSet> = z
  .object({
    actor: z.object({
      type: z.enum(['user', 'automation', 'git', 'system', 'anonymous']),
      id: z.string().min(1).max(200).nullable(),
    }),
    // A UUID, as every entity id of the contracts: the row-level security policies cast it.
    organization_id: z.uuid().nullable(),
    role: z.string().min(1).max(100).nullable(),
    scopes: z.array(z.string().min(1).max(100)).max(100),
    trace_id: z.string().min(1).max(64).optional(),
  })
  .refine(
    (claims: TokenClaimSet) =>
      claims.actor.type === 'anonymous'
        ? claims.actor.id === null &&
          claims.organization_id === null &&
          claims.role === null &&
          claims.scopes.length === 0
        : claims.actor.type === 'system' || claims.actor.id !== null,
    { message: 'Inconsistent actor claims.' },
  );

/**
 * Function assertConsistentContext
 *
 * @description
 * Checks that an organization context could be carried by an internal token, with the rules the
 * signer and the verifier apply to the claims. Internal to the package: used where an
 * application attaches a context it established itself.
 *
 * @param {OrganizationContext} context - Context to check.
 * @returns {void}
 * @throws {Error} When the context is inconsistent; the message names no value.
 */
export function assertConsistentContext(context: OrganizationContext): void {
  const result: z.ZodSafeParseResult<TokenClaimSet> = claimSetSchema.safeParse({
    actor: { type: context.actor.type, id: context.actor.id },
    organization_id: context.organizationId,
    role: context.role,
    scopes: [...context.scopes],
  });
  if (!result.success) {
    throw new Error(
      `Inconsistent organization context: ${result.error.issues
        .map((issue) => (issue.path.length > 0 ? issue.path.join('.') : 'actor'))
        .join(', ')}.`,
    );
  }
}
