import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { OrganizationContextInterceptor } from '../context/organization-context.interceptor.js';
import { InternalTokenGuard } from './internal-token.guard.js';
import { InternalTokenSigner, type InternalTokenSignerOptions } from './internal-token-signer.js';
import {
  InternalTokenVerifier,
  type InternalTokenVerifierOptions,
} from './internal-token-verifier.js';

/**
 * Interface InternalTokenModuleOptions
 *
 * @description
 * Options of `InternalTokenModule.forRoot`. A service that receives internal calls gives
 * `verifier`; a service that calls others gives `signer`; many give both.
 */
export interface InternalTokenModuleOptions {
  // #region Properties
  /**
   * Property verifier
   *
   * @description
   * Audience and trusted issuers of this service. When set, every HTTP route requires a valid
   * internal token unless it is marked with `@SkipInternalToken()`.
   *
   * @type {InternalTokenVerifierOptions | undefined}
   * @readonly
   */
  readonly verifier?: InternalTokenVerifierOptions;

  /**
   * Property signer
   *
   * @description
   * Issuer name and signing key of this service. When set, `InternalTokenSigner` can be
   * injected.
   *
   * @type {InternalTokenSignerOptions | undefined}
   * @readonly
   */
  readonly signer?: InternalTokenSignerOptions;
  // #endregion
}

/**
 * Class InternalTokenModule
 *
 * @description
 * Wires the internal token into an application, globally.
 *
 * With `verifier`, it provides `InternalTokenVerifier` and registers the guard and the
 * organization context interceptor for every HTTP route. With `signer`, it provides
 * `InternalTokenSigner`. With neither it provides nothing, which is what a gateway that only
 * authenticates sessions and signs nothing would get: the default changes no behavior.
 */
@Module({})
export class InternalTokenModule {
  // #region Methods
  /**
   * Method forRoot
   *
   * @description
   * Imports the configured keys while the application starts and registers the providers.
   *
   * @param {InternalTokenModuleOptions} options - Verifier and signer options, from configuration.
   * @returns {DynamicModule} The global module.
   */
  public static forRoot(options: InternalTokenModuleOptions): DynamicModule {
    const providers: Provider[] = [];
    const exported: (typeof InternalTokenVerifier | typeof InternalTokenSigner)[] = [];
    const verifier: InternalTokenVerifierOptions | undefined = options.verifier;
    const signer: InternalTokenSignerOptions | undefined = options.signer;
    if (verifier !== undefined) {
      providers.push(
        {
          provide: InternalTokenVerifier,
          useFactory: (): Promise<InternalTokenVerifier> => InternalTokenVerifier.create(verifier),
        },
        { provide: APP_GUARD, useClass: InternalTokenGuard },
        { provide: APP_INTERCEPTOR, useClass: OrganizationContextInterceptor },
      );
      exported.push(InternalTokenVerifier);
    }
    if (signer !== undefined) {
      providers.push({
        provide: InternalTokenSigner,
        useFactory: (): Promise<InternalTokenSigner> => InternalTokenSigner.create(signer),
      });
      exported.push(InternalTokenSigner);
    }
    return { module: InternalTokenModule, global: true, providers, exports: exported };
  }
  // #endregion
}
