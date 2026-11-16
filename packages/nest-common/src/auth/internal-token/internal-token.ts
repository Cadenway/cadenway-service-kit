import type { InternalActor } from '../context/organization-context.js';

/**
 * Constant INTERNAL_TOKEN_ALGORITHM
 *
 * @description
 * Signature algorithm of the internal token, the only one accepted.
 *
 * @type {'Ed25519'}
 */
export const INTERNAL_TOKEN_ALGORITHM: 'Ed25519' = 'Ed25519';

/**
 * Constant INTERNAL_TOKEN_LIFETIME_SECONDS
 *
 * @description
 * Validity of an internal token, in seconds. A token older than this is refused whatever its
 * own expiry says.
 *
 * @type {number}
 */
export const INTERNAL_TOKEN_LIFETIME_SECONDS: number = 60;

/**
 * Interface Ed25519PublicJwk
 *
 * @description
 * Ed25519 verification key in JWK form.
 */
export interface Ed25519PublicJwk {
  // #region Properties
  /**
   * Property kty
   *
   * @description
   * Key type, always `OKP`.
   *
   * @type {'OKP'}
   * @readonly
   */
  readonly kty: 'OKP';

  /**
   * Property crv
   *
   * @description
   * Curve, always `Ed25519`.
   *
   * @type {'Ed25519'}
   * @readonly
   */
  readonly crv: 'Ed25519';

  /**
   * Property x
   *
   * @description
   * Public key, base64url.
   *
   * @type {string}
   * @readonly
   */
  readonly x: string;

  /**
   * Property kid
   *
   * @description
   * Key id, written in the `kid` header of the tokens the key signs.
   *
   * @type {string}
   * @readonly
   */
  readonly kid: string;
  // #endregion
}

/**
 * Interface Ed25519PrivateJwk
 *
 * @description
 * Ed25519 signing key in JWK form.
 */
export interface Ed25519PrivateJwk extends Ed25519PublicJwk {
  // #region Properties
  /**
   * Property d
   *
   * @description
   * Private key, base64url. A secret: it comes from configuration and is never logged.
   *
   * @type {string}
   * @readonly
   */
  readonly d: string;
  // #endregion
}

/**
 * Interface InternalTokenClaims
 *
 * @description
 * What an issuer states in an internal token: who the call is made for.
 */
export interface InternalTokenClaims {
  // #region Properties
  /**
   * Property actor
   *
   * @description
   * Actor the call is made for. A user, an automation and a Git integration carry an id; an
   * anonymous actor carries none.
   *
   * @type {InternalActor}
   * @readonly
   */
  readonly actor: InternalActor;

  /**
   * Property organizationId
   *
   * @description
   * Organization the call is made in, a UUID, or `null` for a call outside any organization.
   * Always `null` for an anonymous actor.
   *
   * @type {string | null}
   * @readonly
   */
  readonly organizationId: string | null;

  /**
   * Property role
   *
   * @description
   * Member role of the user in the organization. Defaults to `null`.
   *
   * @type {string | null | undefined}
   * @readonly
   */
  readonly role?: string | null;

  /**
   * Property scopes
   *
   * @description
   * Scopes granted to the caller. Defaults to none.
   *
   * @type {readonly string[] | undefined}
   * @readonly
   */
  readonly scopes?: readonly string[];

  /**
   * Property traceId
   *
   * @description
   * Trace id of the request the call belongs to, for audit. The trace itself travels in
   * `traceparent`.
   *
   * @type {string | undefined}
   * @readonly
   */
  readonly traceId?: string;
  // #endregion
}
