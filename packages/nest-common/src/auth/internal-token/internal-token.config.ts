import { z } from 'zod';

import type { ConfigShape } from '../../config/base-config.js';
import type { Ed25519PrivateJwk, Ed25519PublicJwk } from './internal-token.js';

/**
 * Interface InternalTokenSignerConfig
 *
 * @description
 * Variables of a service that calls other services, as validated by
 * `internalTokenSignerConfigShape`.
 */
export interface InternalTokenSignerConfig {
  // #region Properties
  /**
   * Property INTERNAL_TOKEN_ISSUER
   *
   * @description
   * Name of this service, written as `iss` in the tokens it signs.
   *
   * @type {string}
   * @readonly
   */
  readonly INTERNAL_TOKEN_ISSUER: string;

  /**
   * Property INTERNAL_TOKEN_PRIVATE_JWK
   *
   * @description
   * Ed25519 signing key, given as one line of JSON: `kty`, `crv`, `x`, `d` and `kid`. A secret.
   *
   * @type {Ed25519PrivateJwk}
   * @readonly
   */
  readonly INTERNAL_TOKEN_PRIVATE_JWK: Ed25519PrivateJwk;
  // #endregion
}

/**
 * Interface InternalTokenVerifierConfig
 *
 * @description
 * Variables of a service that receives internal calls, as validated by
 * `internalTokenVerifierConfigShape`.
 */
export interface InternalTokenVerifierConfig {
  // #region Properties
  /**
   * Property INTERNAL_TOKEN_AUDIENCE
   *
   * @description
   * Name of this service: the `aud` a token must carry to be accepted here.
   *
   * @type {string}
   * @readonly
   */
  readonly INTERNAL_TOKEN_AUDIENCE: string;

  /**
   * Property INTERNAL_TOKEN_TRUSTED_ISSUERS
   *
   * @description
   * Verification keys of each service allowed to call this one, given as one line of JSON:
   * `{"api-gateway":[{"kty":"OKP","crv":"Ed25519","x":"...","kid":"..."}]}`.
   *
   * @type {Readonly<Record<string, readonly Ed25519PublicJwk[]>>}
   * @readonly
   */
  readonly INTERNAL_TOKEN_TRUSTED_ISSUERS: Readonly<Record<string, readonly Ed25519PublicJwk[]>>;
  // #endregion
}

/**
 * Constant serviceNameSchema
 *
 * @description
 * Name of a service as used in `iss` and `aud`: lowercase kebab-case, such as `task-service`.
 *
 * @type {z.ZodType<string>}
 */
const serviceNameSchema: z.ZodType<string> = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,62}$/u, 'Expected a lowercase kebab-case service name.');

/**
 * Constant keyMaterialSchema
 *
 * @description
 * Base64url text of a 32-byte Ed25519 key.
 *
 * @type {z.ZodType<string>}
 */
const keyMaterialSchema: z.ZodType<string> = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/u, 'Expected 32 bytes in base64url.');

/**
 * Constant keyIdSchema
 *
 * @description
 * Key id written in the `kid` header.
 *
 * @type {z.ZodType<string>}
 */
const keyIdSchema: z.ZodType<string> = z.string().min(1).max(100);

/**
 * Function jsonVariable
 *
 * @description
 * Builds the schema of a variable holding one line of JSON. A text that is not JSON is reported
 * without being echoed.
 *
 * @param {z.ZodType<TValue>} schema - Schema of the parsed JSON.
 * @returns {z.ZodType<TValue>} A schema that takes the text and yields the validated value.
 */
function jsonVariable<TValue>(schema: z.ZodType<TValue>): z.ZodType<TValue> {
  return z
    .string()
    .transform((text: string, context: z.RefinementCtx): unknown => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        context.addIssue({ code: 'custom', message: 'Expected one line of JSON.' });
        return z.NEVER;
      }
    })
    .pipe(schema);
}

/**
 * Constant internalTokenSignerConfigShape
 *
 * @description
 * Zod shape of the variables of a service that signs internal tokens. Spread it into the
 * application schema.
 *
 * @type {ConfigShape<InternalTokenSignerConfig>}
 */
export const internalTokenSignerConfigShape: ConfigShape<InternalTokenSignerConfig> = {
  INTERNAL_TOKEN_ISSUER: serviceNameSchema,
  INTERNAL_TOKEN_PRIVATE_JWK: jsonVariable(
    z.strictObject({
      kty: z.literal('OKP'),
      crv: z.literal('Ed25519'),
      x: keyMaterialSchema,
      d: keyMaterialSchema,
      kid: keyIdSchema,
    }),
  ),
};

/**
 * Constant internalTokenVerifierConfigShape
 *
 * @description
 * Zod shape of the variables of a service that verifies internal tokens. Spread it into the
 * application schema. A private key listed as a verification key is refused.
 *
 * @type {ConfigShape<InternalTokenVerifierConfig>}
 */
export const internalTokenVerifierConfigShape: ConfigShape<InternalTokenVerifierConfig> = {
  INTERNAL_TOKEN_AUDIENCE: serviceNameSchema,
  INTERNAL_TOKEN_TRUSTED_ISSUERS: jsonVariable(
    z
      .record(
        serviceNameSchema,
        z
          .array(
            z.strictObject({
              kty: z.literal('OKP'),
              crv: z.literal('Ed25519'),
              x: keyMaterialSchema,
              kid: keyIdSchema,
            }),
          )
          .min(1),
      )
      .refine(
        (issuers: Record<string, unknown>) => Object.keys(issuers).length > 0,
        'Expected at least one trusted issuer.',
      ),
  ),
};
