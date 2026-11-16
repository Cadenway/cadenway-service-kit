import type { OrganizationContext } from './organization-context.js';

/**
 * Interface InternalPrincipal
 *
 * @description
 * Verified content of an internal token: the organization context plus where the token came
 * from.
 */
export interface InternalPrincipal extends OrganizationContext {
  // #region Properties
  /**
   * Property issuer
   *
   * @description
   * Service that signed the token, one of the trusted issuers.
   *
   * @type {string}
   * @readonly
   */
  readonly issuer: string;

  /**
   * Property audience
   *
   * @description
   * Service the token was issued for: this one.
   *
   * @type {string}
   * @readonly
   */
  readonly audience: string;

  /**
   * Property traceId
   *
   * @description
   * Trace id stated by the issuer, or `null`.
   *
   * @type {string | null}
   * @readonly
   */
  readonly traceId: string | null;
  // #endregion
}
