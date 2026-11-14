import {
  decodeJwt,
  decodeProtectedHeader,
  errors,
  importJWK,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JWTPayload,
  type ProtectedHeaderParameters,
} from 'jose';
import { z } from 'zod';

import { ProblemException } from '../problem/problem.js';
import type { InternalActor, OrganizationContext } from './organization-context.js';

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
 * Constant DEFAULT_CLOCK_TOLERANCE_SECONDS
 *
 * @description
 * Clock difference tolerated between the issuer and the verifier, in seconds.
 *
 * @type {number}
 */
const DEFAULT_CLOCK_TOLERANCE_SECONDS: number = 5;

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
 * Interface TokenClaimSet
 *
 * @description
 * Private claims of the internal token, as written in the JWT payload.
 */
interface TokenClaimSet {
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
const claimSetSchema: z.ZodType<TokenClaimSet> = z
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
 * Function invalidToken
 *
 * @description
 * Builds the problem answered to a token that cannot be accepted.
 *
 * @param {InvalidTokenReason} reason - Why the token is refused.
 * @param {unknown} cause - Underlying error, kept for the logs.
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
