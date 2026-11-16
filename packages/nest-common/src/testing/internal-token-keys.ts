import { exportJWK, generateKeyPair, type JWK } from 'jose';

import type { Ed25519PrivateJwk, Ed25519PublicJwk } from '../auth/internal-token/internal-token.js';

/**
 * Function generateSigningJwk
 *
 * @description
 * Generates a fresh Ed25519 signing key for a spec. Keys are never written in the repository:
 * every run makes its own.
 *
 * @param {string} kid - Key id to give the key.
 * @returns {Promise<Ed25519PrivateJwk>} The private JWK.
 */
export async function generateSigningJwk(kid: string): Promise<Ed25519PrivateJwk> {
  const pair: { privateKey: CryptoKey } = await generateKeyPair('Ed25519', { extractable: true });
  const jwk: JWK = await exportJWK(pair.privateKey);
  if (jwk.x === undefined || jwk.d === undefined) {
    throw new Error('The generated key is not an Ed25519 private key.');
  }
  return { kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d, kid };
}

/**
 * Function publicJwkOf
 *
 * @description
 * Returns the verification key matching a signing key.
 *
 * @param {Ed25519PrivateJwk} jwk - Signing key.
 * @returns {Ed25519PublicJwk} The public JWK, without the private member.
 */
export function publicJwkOf(jwk: Ed25519PrivateJwk): Ed25519PublicJwk {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid: jwk.kid };
}
