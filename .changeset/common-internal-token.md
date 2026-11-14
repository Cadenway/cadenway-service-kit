---
'@cadenway/nest-common': minor
---

Add the internal token and the organization context.

- `InternalTokenSigner` and `InternalTokenVerifier`: a JWT signed with `alg: Ed25519`, valid 60 seconds, with `aud` set to the called service and a `kid` header. Several issuers are trusted, each with its own keys; a key is accepted only for the issuer it is configured under.
- `InternalTokenModule.forRoot({ verifier, signer })`, `InternalTokenGuard`, `@InternalAccess()` and `@SkipInternalToken()`. A route requires an organization and refuses an anonymous subject unless it declares otherwise.
- `internalTokenVerifierConfigShape` and `internalTokenSignerConfigShape`: `INTERNAL_TOKEN_AUDIENCE`, `INTERNAL_TOKEN_TRUSTED_ISSUERS`, `INTERNAL_TOKEN_ISSUER` and `INTERNAL_TOKEN_PRIVATE_JWK`.
- Organization context in an `AsyncLocalStorage`, derived from the verified token: `getOrganizationContext`, `requireOrganizationId`, `principalOf`, `runWithOrganizationContext` and `OrganizationContextInterceptor`.
- Logs carry `organizationId` and `userId` inside an organization context.

Nothing changes for an application that does not import `InternalTokenModule`. The health routes are exempt from the guard.
