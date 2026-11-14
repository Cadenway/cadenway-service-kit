import { importJWK, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { loadConfig } from '../config/load-config.js';
import { ProblemException } from '../problem/problem.js';
import { generateSigningJwk, publicJwkOf } from '../testing/internal-token-keys.js';
import {
  internalTokenSignerConfigShape,
  internalTokenVerifierConfigShape,
  type InternalTokenSignerConfig,
  type InternalTokenVerifierConfig,
} from './internal-token.config.js';
import {
  InternalTokenSigner,
  InternalTokenVerifier,
  type Ed25519PrivateJwk,
  type InternalPrincipal,
  type InternalTokenClaims,
} from './internal-token.js';

/**
 * Constant userClaims
 *
 * @description
 * Claims of a signed-in member of Atelier Nord.
 *
 * @type {InternalTokenClaims}
 */
const userClaims: InternalTokenClaims = {
  actor: { type: 'user', id: 'user-camille' },
  organizationId: 'org-atelier-nord',
  role: 'admin',
  scopes: ['tasks:read', 'tasks:write'],
  traceId: '0af7651916cd43dd8448eb211c80319c',
};

/**
 * Function refusal
 *
 * @description
 * Awaits a verification expected to fail and returns its status and reason.
 *
 * @param {Promise<unknown>} verification - Pending verification.
 * @returns {Promise<string>} `<status> <code> <reason>` of the problem.
 */
async function refusal(verification: Promise<unknown>): Promise<string> {
  try {
    await verification;
  } catch (error) {
    if (error instanceof ProblemException) {
      const reason: unknown = error.problem.details?.reason;
      return `${String(error.problem.status)} ${error.problem.code} ${String(reason)}`;
    }
    throw error;
  }
  throw new Error('Expected the token to be refused.');
}

describe('internal token', () => {
  let gatewayJwk: Ed25519PrivateJwk;
  let automationJwk: Ed25519PrivateJwk;
  let gateway: InternalTokenSigner;
  let automation: InternalTokenSigner;
  let taskService: InternalTokenVerifier;

  beforeAll(async () => {
    gatewayJwk = await generateSigningJwk('gateway-2026-11');
    automationJwk = await generateSigningJwk('automation-2026-11');
    gateway = await InternalTokenSigner.create({ issuer: 'api-gateway', privateJwk: gatewayJwk });
    automation = await InternalTokenSigner.create({
      issuer: 'automation-service',
      privateJwk: automationJwk,
    });
    taskService = await InternalTokenVerifier.create({
      audience: 'task-service',
      trustedIssuers: {
        'api-gateway': [publicJwkOf(gatewayJwk)],
        'automation-service': [publicJwkOf(automationJwk)],
      },
    });
  });

  it('verifies a token and returns the principal the issuer stated', async () => {
    const principal: InternalPrincipal = await taskService.verify(
      await gateway.sign('task-service', userClaims),
    );

    expect(principal).toEqual({
      issuer: 'api-gateway',
      audience: 'task-service',
      actor: { type: 'user', id: 'user-camille' },
      organizationId: 'org-atelier-nord',
      role: 'admin',
      scopes: ['tasks:read', 'tasks:write'],
      traceId: '0af7651916cd43dd8448eb211c80319c',
    });
  });

  it('accepts every configured issuer, each with its own key', async () => {
    const principal: InternalPrincipal = await taskService.verify(
      await automation.sign('task-service', {
        actor: { type: 'automation', id: 'rule-42' },
        organizationId: 'org-atelier-nord',
      }),
    );

    expect(principal).toMatchObject({
      issuer: 'automation-service',
      actor: { type: 'automation', id: 'rule-42' },
      role: null,
      scopes: [],
      traceId: null,
    });
  });

  it('accepts an anonymous and a system subject without an organization', async () => {
    const anonymous: InternalPrincipal = await taskService.verify(
      await gateway.sign('task-service', {
        actor: { type: 'anonymous', id: null },
        organizationId: null,
      }),
    );
    const system: InternalPrincipal = await taskService.verify(
      await gateway.sign('task-service', {
        actor: { type: 'system', id: null },
        organizationId: null,
      }),
    );

    expect(anonymous).toMatchObject({ actor: { type: 'anonymous', id: null }, scopes: [] });
    expect(system).toMatchObject({ actor: { type: 'system', id: null }, organizationId: null });
  });

  it('refuses a token issued for another service', async () => {
    const token: string = await gateway.sign('billing-service', userClaims);

    expect(await refusal(taskService.verify(token))).toBe('401 auth.token-invalid audience');
  });

  it('refuses a token older than 60 seconds, even when it claims a later expiry', async () => {
    const past: InternalTokenSigner = await InternalTokenSigner.create({
      issuer: 'api-gateway',
      privateJwk: gatewayJwk,
      clock: () => new Date(Date.now() - 70_000),
    });
    const longLived: string = await new SignJWT({
      actor: { type: 'system', id: null },
      organization_id: null,
      role: null,
      scopes: [],
    })
      .setProtectedHeader({ alg: 'Ed25519', kid: gatewayJwk.kid, typ: 'JWT' })
      .setIssuer('api-gateway')
      .setAudience('task-service')
      .setSubject('system')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(await importJWK(gatewayJwk, 'Ed25519'));

    expect(await refusal(taskService.verify(await past.sign('task-service', userClaims)))).toBe(
      '401 auth.token-invalid expired',
    );
    expect(await refusal(taskService.verify(longLived))).toBe('401 auth.token-invalid expired');
  });

  it('refuses an untrusted issuer', async () => {
    const stranger: InternalTokenSigner = await InternalTokenSigner.create({
      issuer: 'unknown-service',
      privateJwk: gatewayJwk,
    });

    expect(await refusal(taskService.verify(await stranger.sign('task-service', userClaims)))).toBe(
      '401 auth.token-invalid issuer',
    );
  });

  it('refuses a key used under the name of another issuer', async () => {
    const impostor: InternalTokenSigner = await InternalTokenSigner.create({
      issuer: 'api-gateway',
      privateJwk: automationJwk,
    });
    const sameKeyId: InternalTokenSigner = await InternalTokenSigner.create({
      issuer: 'api-gateway',
      privateJwk: { ...automationJwk, kid: gatewayJwk.kid },
    });

    expect(await refusal(taskService.verify(await impostor.sign('task-service', userClaims)))).toBe(
      '401 auth.token-invalid key',
    );
    expect(
      await refusal(taskService.verify(await sameKeyId.sign('task-service', userClaims))),
    ).toBe('401 auth.token-invalid signature');
  });

  it('refuses a tampered token, another algorithm and text that is not a token', async () => {
    const token: string = await gateway.sign('task-service', userClaims);
    const [header, payload, signature]: string[] = token.split('.');
    const forgedPayload: string = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as object),
        organization_id: 'org-other',
      }),
    ).toString('base64url');
    const symmetric: string = await new SignJWT({ scopes: [] })
      .setProtectedHeader({ alg: 'HS256', kid: gatewayJwk.kid, typ: 'JWT' })
      .setIssuer('api-gateway')
      .setAudience('task-service')
      .setSubject('system')
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(Buffer.from(gatewayJwk.x, 'base64url'));

    expect(
      await refusal(taskService.verify(`${header ?? ''}.${forgedPayload}.${signature ?? ''}`)),
    ).toBe('401 auth.token-invalid signature');
    expect(await refusal(taskService.verify(symmetric))).toBe('401 auth.token-invalid malformed');
    expect(await refusal(taskService.verify('not-a-token'))).toBe(
      '401 auth.token-invalid malformed',
    );
  });

  it('refuses a validly signed token whose claims are inconsistent', async () => {
    const token: string = await new SignJWT({
      actor: { type: 'anonymous', id: null },
      organization_id: 'org-atelier-nord',
      role: null,
      scopes: [],
    })
      .setProtectedHeader({ alg: 'Ed25519', kid: gatewayJwk.kid, typ: 'JWT' })
      .setIssuer('api-gateway')
      .setAudience('task-service')
      .setSubject('anonymous')
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(await importJWK(gatewayJwk, 'Ed25519'));

    expect(await refusal(taskService.verify(token))).toBe('401 auth.token-invalid claims');
  });

  it('refuses to sign inconsistent claims', async () => {
    await expect(
      gateway.sign('task-service', {
        actor: { type: 'anonymous', id: null },
        organizationId: 'org-atelier-nord',
      }),
    ).rejects.toThrow();
    await expect(
      gateway.sign('task-service', { actor: { type: 'user', id: null }, organizationId: null }),
    ).rejects.toThrow();
  });

  it('refuses a verifier without issuer, and a private key as verification key', async () => {
    await expect(
      InternalTokenVerifier.create({ audience: 'task-service', trustedIssuers: {} }),
    ).rejects.toThrow(/At least one trusted issuer/u);
    await expect(
      InternalTokenVerifier.create({
        audience: 'task-service',
        trustedIssuers: { 'api-gateway': [gatewayJwk] },
      }),
    ).rejects.toThrow(/private key cannot be a verification key/u);
  });

  describe('configuration', () => {
    /**
     * Constant schema
     *
     * @description
     * Schema of a service that both signs and verifies internal tokens.
     *
     * @type {z.ZodType<InternalTokenSignerConfig & InternalTokenVerifierConfig>}
     */
    const schema: z.ZodType<InternalTokenSignerConfig & InternalTokenVerifierConfig> = z.object({
      ...internalTokenSignerConfigShape,
      ...internalTokenVerifierConfigShape,
    });

    it('reads the keys and issuers from one-line JSON variables', async () => {
      const config: InternalTokenSignerConfig & InternalTokenVerifierConfig = loadConfig(schema, {
        INTERNAL_TOKEN_ISSUER: 'automation-service',
        INTERNAL_TOKEN_PRIVATE_JWK: JSON.stringify(automationJwk),
        INTERNAL_TOKEN_AUDIENCE: 'automation-service',
        INTERNAL_TOKEN_TRUSTED_ISSUERS: JSON.stringify({
          'api-gateway': [publicJwkOf(gatewayJwk)],
        }),
      });
      const signer: InternalTokenSigner = await InternalTokenSigner.create({
        issuer: config.INTERNAL_TOKEN_ISSUER,
        privateJwk: config.INTERNAL_TOKEN_PRIVATE_JWK,
      });

      expect(config.INTERNAL_TOKEN_TRUSTED_ISSUERS).toEqual({
        'api-gateway': [publicJwkOf(gatewayJwk)],
      });
      await expect(
        taskService.verify(await signer.sign('task-service', userClaims)),
      ).resolves.toBeDefined();
    });

    it('refuses a private key among the verification keys, without echoing it', () => {
      try {
        loadConfig(schema, {
          INTERNAL_TOKEN_ISSUER: 'automation-service',
          INTERNAL_TOKEN_PRIVATE_JWK: JSON.stringify(automationJwk),
          INTERNAL_TOKEN_AUDIENCE: 'automation-service',
          INTERNAL_TOKEN_TRUSTED_ISSUERS: JSON.stringify({ 'api-gateway': [gatewayJwk] }),
        });
        expect.unreachable('a private verification key must be refused');
      } catch (error) {
        expect((error as Error).message).toContain('INTERNAL_TOKEN_TRUSTED_ISSUERS');
        expect((error as Error).message).not.toContain(gatewayJwk.d);
      }
    });

    it('refuses text that is not JSON, without echoing it', () => {
      try {
        loadConfig(schema, {
          INTERNAL_TOKEN_ISSUER: 'Automation Service',
          INTERNAL_TOKEN_PRIVATE_JWK: 'secret-that-is-not-json',
          INTERNAL_TOKEN_AUDIENCE: 'automation-service',
          INTERNAL_TOKEN_TRUSTED_ISSUERS: '{}',
        });
        expect.unreachable('invalid variables must be refused');
      } catch (error) {
        const message: string = (error as Error).message;
        expect(message).toContain('INTERNAL_TOKEN_ISSUER');
        expect(message).toContain('INTERNAL_TOKEN_PRIVATE_JWK: Expected one line of JSON.');
        expect(message).toContain('INTERNAL_TOKEN_TRUSTED_ISSUERS');
        expect(message).not.toContain('secret-that-is-not-json');
      }
    });
  });
});
