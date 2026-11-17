import {
  decodeJwt,
  decodeProtectedHeader,
  errors,
  importJWK,
  jwtVerify,
  type CryptoKey,
  type JWTPayload,
  type ProtectedHeaderParameters,
} from 'jose';
import type { z } from 'zod';

import { ProblemException } from '../../problem/problem.js';
import type { InternalPrincipal } from '../context/internal-principal.js';
import { claimSetSchema, type TokenClaimSet } from '../context/organization-claims.js';
import {
  INTERNAL_TOKEN_ALGORITHM,
  INTERNAL_TOKEN_LIFETIME_SECONDS,
  type Ed25519PublicJwk,
} from './internal-token.js';

/**
 * Constant DEFAULT_CLOCK_TOLERANCE_SECONDS
 *
 * @description
 * Clock difference tolerated between the issuer and the verifier, in seconds.
 *
 * @type {number}
 */
const DEFAULT_CLOCK_TOLERANCE_SECONDS: number = 5;

/**
 * Interface InternalTokenVerifierOptions
 *
 * @description
 * Options of `InternalTokenVerifier.create`. Audience, issuers and keys come from configuration.
 */
export interface InternalTokenVerifierOptions {
  // #region Properties
  /**
   * Property audience
   *
   * @description
   * Name of this service. A token issued for another service is refused.
   *
   * @type {string}
   * @readonly
   */
  readonly audience: string;

  /**
   * Property trustedIssuers
   *
   * @description
   * Verification keys of each service allowed to call this one, by issuer name. A key is
   * accepted only for the issuer it is listed under; several keys per issuer allow a rotation.
   *
   * @type {Readonly<Record<string, readonly Ed25519PublicJwk[]>>}
   * @readonly
   */
  readonly trustedIssuers: Readonly<Record<string, readonly Ed25519PublicJwk[]>>;

  /**
   * Property clockToleranceSeconds
   *
   * @description
   * Clock difference tolerated with the issuer, in seconds. Defaults to 5.
   *
   * @type {number | undefined}
   * @readonly
   */
  readonly clockToleranceSeconds?: number;

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
 * Type InvalidTokenReason
 *
 * @description
 * Why a token was refused, given in `details.reason` of the 401 problem.
 *
 * @type {'malformed' | 'issuer' | 'key' | 'signature' | 'audience' | 'expired' | 'claims'}
 */
export type InvalidTokenReason =
  'malformed' | 'issuer' | 'key' | 'signature' | 'audience' | 'expired' | 'claims';

/**
 * Function invalidToken
 *
 * @description
 * Builds the problem answered to a token that cannot be accepted.
 *
 * @param {InvalidTokenReason} reason - Why the token is refused.
 * @param {unknown | undefined} cause - Underlying error, kept for the logs.
 * @returns {ProblemException} A 401 `auth.token-invalid` problem.
 */
function invalidToken(reason: InvalidTokenReason, cause?: unknown): ProblemException {
  return new ProblemException({
    status: 401,
    code: 'auth.token-invalid',
    detail: 'The internal token is not valid for this service.',
    details: { reason },
    cause,
  });
}

/**
 * Function reasonOf
 *
 * @description
 * Classifies a verification error of `jose`.
 *
 * @param {unknown} error - Error thrown by the verification.
 * @returns {InvalidTokenReason} The reason reported to the caller.
 */
function reasonOf(error: unknown): InvalidTokenReason {
  if (error instanceof errors.JWTExpired) {
    return 'expired';
  }
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === 'aud') {
      return 'audience';
    }
    return error.claim === 'iat' ? 'expired' : 'claims';
  }
  if (error instanceof errors.JWSSignatureVerificationFailed) {
    return 'signature';
  }
  return 'malformed';
}

/**
 * Class InternalTokenVerifier
 *
 * @description
 * Verifies the internal token of an incoming call.
 *
 * A token is accepted when its issuer is trusted, its `kid` names a key configured for that very
 * issuer, its Ed25519 signature is valid, its `aud` is this service, it is at most 60 seconds
 * old and its claims are well formed. Every other token answers 401 `auth.token-invalid`, with
 * the reason in `details.reason`.
 */
export class InternalTokenVerifier {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Stores the imported keys. Use `InternalTokenVerifier.create`.
   *
   * @param {string} audience - Name of this service.
   * @param {ReadonlyMap<string, ReadonlyMap<string, CryptoKey>>} keys - Keys by issuer, then by `kid`.
   * @param {number} clockToleranceSeconds - Clock difference tolerated with the issuer.
   * @param {() => Date} clock - Source of the current time.
   * @constructor
   */
  private constructor(
    private readonly audience: string,
    private readonly keys: ReadonlyMap<string, ReadonlyMap<string, CryptoKey>>,
    private readonly clockToleranceSeconds: number,
    private readonly clock: () => Date,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Method create
   *
   * @description
   * Imports the verification keys of every trusted issuer and returns a verifier.
   *
   * @param {InternalTokenVerifierOptions} options - Audience, trusted issuers and their keys.
   * @returns {Promise<InternalTokenVerifier>} The verifier.
   * @throws {Error} When no issuer is trusted, an issuer has no key, or a key is not an Ed25519 public JWK.
   */
  public static async create(
    options: InternalTokenVerifierOptions,
  ): Promise<InternalTokenVerifier> {
    const keys: Map<string, Map<string, CryptoKey>> = new Map<string, Map<string, CryptoKey>>();
    for (const [issuer, jwks] of Object.entries(options.trustedIssuers)) {
      const issuerKeys: Map<string, CryptoKey> = new Map<string, CryptoKey>();
      for (const jwk of jwks) {
        if ('d' in jwk) {
          throw new Error(`Issuer ${issuer}: a private key cannot be a verification key.`);
        }
        const key: CryptoKey | Uint8Array = await importJWK(
          { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
          INTERNAL_TOKEN_ALGORITHM,
        );
        if (key instanceof Uint8Array) {
          throw new Error(`Issuer ${issuer}: verification keys must be asymmetric.`);
        }
        issuerKeys.set(jwk.kid, key);
      }
      if (issuerKeys.size === 0) {
        throw new Error(`Issuer ${issuer}: at least one verification key is required.`);
      }
      keys.set(issuer, issuerKeys);
    }
    if (keys.size === 0) {
      throw new Error('At least one trusted issuer is required to verify internal tokens.');
    }
    return new InternalTokenVerifier(
      options.audience,
      keys,
      options.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS,
      options.clock ?? ((): Date => new Date()),
    );
  }

  /**
   * Method verify
   *
   * @description
   * Verifies a token and returns who the call is made for.
   *
   * @param {string} token - Compact JWT taken from the `Authorization` header.
   * @returns {Promise<InternalPrincipal>} The verified principal.
   * @throws {ProblemException} 401 `auth.token-invalid` when the token is not acceptable.
   */
  public async verify(token: string): Promise<InternalPrincipal> {
    let issuer: string | undefined;
    let keyId: string | undefined;
    try {
      const header: ProtectedHeaderParameters = decodeProtectedHeader(token);
      keyId = header.kid;
      issuer = decodeJwt(token).iss;
    } catch (error) {
      throw invalidToken('malformed', error);
    }
    const issuerKeys: ReadonlyMap<string, CryptoKey> | undefined =
      issuer === undefined ? undefined : this.keys.get(issuer);
    if (issuer === undefined || issuerKeys === undefined) {
      throw invalidToken('issuer');
    }
    const key: CryptoKey | undefined = keyId === undefined ? undefined : issuerKeys.get(keyId);
    if (key === undefined) {
      throw invalidToken('key');
    }
    let payload: JWTPayload;
    try {
      payload = (
        await jwtVerify(token, key, {
          algorithms: [INTERNAL_TOKEN_ALGORITHM],
          issuer,
          audience: this.audience,
          typ: 'JWT',
          requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp'],
          maxTokenAge: INTERNAL_TOKEN_LIFETIME_SECONDS,
          clockTolerance: this.clockToleranceSeconds,
          currentDate: this.clock(),
        })
      ).payload;
    } catch (error) {
      throw invalidToken(reasonOf(error), error);
    }
    const claims: z.ZodSafeParseResult<TokenClaimSet> = claimSetSchema.safeParse(payload);
    if (!claims.success) {
      throw invalidToken('claims');
    }
    return Object.freeze({
      issuer,
      audience: this.audience,
      actor: Object.freeze({ type: claims.data.actor.type, id: claims.data.actor.id }),
      organizationId: claims.data.organization_id,
      role: claims.data.role,
      scopes: Object.freeze([...claims.data.scopes]),
      traceId: claims.data.trace_id ?? null,
    });
  }
  // #endregion
}
