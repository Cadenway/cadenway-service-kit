import { importJWK, SignJWT, type CryptoKey } from 'jose';

import { claimSetSchema, type TokenClaimSet } from '../context/organization-claims.js';
import {
  INTERNAL_TOKEN_ALGORITHM,
  INTERNAL_TOKEN_LIFETIME_SECONDS,
  type Ed25519PrivateJwk,
  type InternalTokenClaims,
} from './internal-token.js';

/**
 * Interface InternalTokenSignerOptions
 *
 * @description
 * Options of `InternalTokenSigner.create`. Both values come from configuration.
 */
export interface InternalTokenSignerOptions {
  // #region Properties
  /**
   * Property issuer
   *
   * @description
   * Name of this service, written as `iss`. The called services list it among their trusted
   * issuers.
   *
   * @type {string}
   * @readonly
   */
  readonly issuer: string;

  /**
   * Property privateJwk
   *
   * @description
   * Ed25519 signing key of this service, with its `kid`.
   *
   * @type {Ed25519PrivateJwk}
   * @readonly
   */
  readonly privateJwk: Ed25519PrivateJwk;

  /**
   * Property clock
   *
   * @description
   * Source of the current time. Defaults to the system clock; meant for tests.
   *
   * @type {(() => Date) | undefined}
   * @readonly
   */
  readonly clock?: () => Date;
  // #endregion
}

/**
 * Class InternalTokenSigner
 *
 * @description
 * Signs the internal token a service sends with every call to another service: a JWT signed with
 * Ed25519, valid 60 seconds, with `aud` set to the called service and a `kid` header.
 *
 * Any service that calls another one owns a signer: the API gateway, the realtime gateway,
 * automation-service, integration-service. The issuer name and the key come from configuration.
 */
export class InternalTokenSigner {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Stores the imported key. Use `InternalTokenSigner.create`.
   *
   * @param {string} issuer - Name of this service.
   * @param {string} keyId - `kid` of the signing key.
   * @param {CryptoKey} key - Imported signing key.
   * @param {() => Date} clock - Source of the current time.
   * @constructor
   */
  private constructor(
    private readonly issuer: string,
    private readonly keyId: string,
    private readonly key: CryptoKey,
    private readonly clock: () => Date,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Method create
   *
   * @description
   * Imports the signing key and returns a signer.
   *
   * @param {InternalTokenSignerOptions} options - Issuer name and signing key.
   * @returns {Promise<InternalTokenSigner>} The signer.
   * @throws {Error} When the key is not an Ed25519 private JWK.
   */
  public static async create(options: InternalTokenSignerOptions): Promise<InternalTokenSigner> {
    const key: CryptoKey | Uint8Array = await importJWK(
      { kty: 'OKP', crv: 'Ed25519', x: options.privateJwk.x, d: options.privateJwk.d },
      INTERNAL_TOKEN_ALGORITHM,
    );
    if (key instanceof Uint8Array) {
      throw new Error('The internal token signing key must be an asymmetric key.');
    }
    return new InternalTokenSigner(
      options.issuer,
      options.privateJwk.kid,
      key,
      options.clock ?? ((): Date => new Date()),
    );
  }

  /**
   * Method sign
   *
   * @description
   * Signs a token for one called service.
   *
   * @param {string} audience - Name of the called service, written as `aud`.
   * @param {InternalTokenClaims} claims - Who the call is made for.
   * @returns {Promise<string>} The compact JWT, to send as `Authorization: Bearer`.
   * @throws {Error} When the claims are inconsistent, such as an anonymous actor with an organization.
   */
  public async sign(audience: string, claims: InternalTokenClaims): Promise<string> {
    const claimSet: TokenClaimSet = claimSetSchema.parse({
      actor: { type: claims.actor.type, id: claims.actor.id },
      organization_id: claims.organizationId,
      role: claims.role ?? null,
      scopes: [...(claims.scopes ?? [])],
      ...(claims.traceId === undefined ? {} : { trace_id: claims.traceId }),
    });
    const issuedAt: number = Math.floor(this.clock().getTime() / 1000);
    return new SignJWT({ ...claimSet })
      .setProtectedHeader({ alg: INTERNAL_TOKEN_ALGORITHM, kid: this.keyId, typ: 'JWT' })
      .setIssuer(this.issuer)
      .setAudience(audience)
      .setSubject(
        claimSet.actor.id === null
          ? claimSet.actor.type
          : `${claimSet.actor.type}:${claimSet.actor.id}`,
      )
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + INTERNAL_TOKEN_LIFETIME_SECONDS)
      .sign(this.key);
  }
  // #endregion
}
