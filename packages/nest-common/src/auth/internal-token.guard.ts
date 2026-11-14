import {
  Injectable,
  SetMetadata,
  type CallHandler,
  type CanActivate,
  type CustomDecorator,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, type Subscriber } from 'rxjs';

import { ProblemException } from '../problem/problem.js';
import { InternalTokenVerifier, type InternalPrincipal } from './internal-token.js';
import { runWithOrganizationContext, type InternalActorType } from './organization-context.js';

/**
 * Interface InternalAccessOptions
 *
 * @description
 * What a route accepts from the internal token, declared with `@InternalAccess`.
 */
export interface InternalAccessOptions {
  // #region Properties
  /**
   * Property actors
   *
   * @description
   * Actor types the route accepts. Defaults to `user`, `automation`, `git` and `system`: an
   * anonymous actor is refused unless the route lists it.
   *
   * @type {readonly InternalActorType[] | undefined}
   * @readonly
   */
  readonly actors?: readonly InternalActorType[];

  /**
   * Property organization
   *
   * @description
   * Whether the token must carry an organization. Defaults to `required`; a route with no
   * organization (sign-up, sign-in, introspection, intake form, webhooks) sets `optional`.
   *
   * @type {'required' | 'optional' | undefined}
   * @readonly
   */
  readonly organization?: 'required' | 'optional';

  /**
   * Property issuers
   *
   * @description
   * Issuers the route accepts, among the trusted ones. Defaults to all of them.
   *
   * @type {readonly string[] | undefined}
   * @readonly
   */
  readonly issuers?: readonly string[];
  // #endregion
}

/**
 * Constant INTERNAL_ACCESS_KEY
 *
 * @description
 * Metadata key of `@InternalAccess`.
 *
 * @type {string}
 */
const INTERNAL_ACCESS_KEY: string = 'cadenway:internal-access';

/**
 * Constant SKIP_INTERNAL_TOKEN_KEY
 *
 * @description
 * Metadata key of `@SkipInternalToken`.
 *
 * @type {string}
 */
const SKIP_INTERNAL_TOKEN_KEY: string = 'cadenway:skip-internal-token';

/**
 * Constant DEFAULT_ACTORS
 *
 * @description
 * Actor types a route accepts when it declares nothing.
 *
 * @type {readonly InternalActorType[]}
 */
const DEFAULT_ACTORS: readonly InternalActorType[] = ['user', 'automation', 'git', 'system'];

/**
 * Constant PRINCIPAL_PROPERTY
 *
 * @description
 * Request property holding the verified principal.
 *
 * @type {'internalPrincipal'}
 */
const PRINCIPAL_PROPERTY: 'internalPrincipal' = 'internalPrincipal';

/**
 * Function InternalAccess
 *
 * @description
 * Declares what a controller or a route accepts from the internal token, when the defaults (an
 * organization, no anonymous actor, any trusted issuer) do not fit. The declaration on a method
 * replaces the one on its class.
 *
 * @param {InternalAccessOptions} options - Accepted actors, organization requirement and issuers.
 * @returns {CustomDecorator} The class or method decorator.
 */
export function InternalAccess(options: InternalAccessOptions): CustomDecorator {
  return SetMetadata(INTERNAL_ACCESS_KEY, options);
}

/**
 * Function SkipInternalToken
 *
 * @description
 * Exempts a controller or a route from the internal token. For routes no service calls with a
 * token, such as the health probes; never for a route that reads or writes data.
 *
 * @returns {CustomDecorator} The class or method decorator.
 */
export function SkipInternalToken(): CustomDecorator {
  return SetMetadata(SKIP_INTERNAL_TOKEN_KEY, true);
}

/**
 * Function principalOf
 *
 * @description
 * Reads the principal the guard verified for a request.
 *
 * @param {object} request - Incoming request.
 * @returns {InternalPrincipal | undefined} The verified principal, or `undefined` on a route without a token.
 */
export function principalOf(request: object): InternalPrincipal | undefined {
  return (request as { [PRINCIPAL_PROPERTY]?: InternalPrincipal })[PRINCIPAL_PROPERTY];
}

/**
 * Function forbidden
 *
 * @description
 * Builds the problem answered to a valid token the route does not accept.
 *
 * @param {string} code - Stable code of the refusal.
 * @param {string} detail - Explanation of the refusal.
 * @returns {ProblemException} A 403 problem.
 */
function forbidden(code: string, detail: string): ProblemException {
  return new ProblemException({ status: 403, code, detail });
}

/**
 * Class InternalTokenGuard
 *
 * @description
 * Requires a valid internal token on every HTTP route, then checks the token against what the
 * route accepts.
 *
 * | Situation                                        | Answer                              |
 * | ------------------------------------------------ | ----------------------------------- |
 * | No `Authorization: Bearer` header                | 401 `auth.token-missing`            |
 * | Token refused by the verifier                    | 401 `auth.token-invalid`            |
 * | Issuer not accepted by the route                 | 403 `auth.issuer-not-allowed`       |
 * | Actor type not accepted by the route             | 403 `auth.actor-not-allowed`        |
 * | No organization on a route that requires one     | 403 `auth.organization-required`    |
 *
 * The verified principal is attached to the request (`principalOf`). Routes marked with
 * `@SkipInternalToken()` are let through without a token.
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  // #region Constructor
  /**
   * Constructor
   *
   * @description
   * Receives the verifier and the metadata reader.
   *
   * @param {InternalTokenVerifier} verifier - Verifier of the incoming tokens.
   * @param {Reflector} reflector - Reader of the route declarations.
   * @constructor
   */
  public constructor(
    private readonly verifier: InternalTokenVerifier,
    private readonly reflector: Reflector,
  ) {}
  // #endregion

  // #region Methods
  /**
   * Method canActivate
   *
   * @description
   * Verifies the token of the request and enforces the route declaration.
   *
   * @param {ExecutionContext} context - Execution context of the request.
   * @returns {Promise<boolean>} `true` when the request may proceed.
   * @throws {ProblemException} 401 or 403, as listed on the class.
   */
  public async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(SKIP_INTERNAL_TOKEN_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    const request: {
      headers: Record<string, string | string[] | undefined>;
      [PRINCIPAL_PROPERTY]?: InternalPrincipal;
    } = context.switchToHttp().getRequest();
    const authorization: string | string[] | undefined = request.headers.authorization;
    const match: RegExpExecArray | null =
      typeof authorization === 'string' ? /^Bearer ([^\s]+)$/u.exec(authorization) : null;
    if (match?.[1] === undefined) {
      throw new ProblemException({
        status: 401,
        code: 'auth.token-missing',
        detail: 'This route requires an internal token.',
      });
    }
    const principal: InternalPrincipal = await this.verifier.verify(match[1]);
    const access: InternalAccessOptions =
      this.reflector.getAllAndOverride<InternalAccessOptions | undefined>(INTERNAL_ACCESS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? {};
    if (access.issuers !== undefined && !access.issuers.includes(principal.issuer)) {
      throw forbidden('auth.issuer-not-allowed', 'This route does not accept this issuer.');
    }
    if (!(access.actors ?? DEFAULT_ACTORS).includes(principal.actor.type)) {
      throw forbidden('auth.actor-not-allowed', 'This route does not accept this kind of actor.');
    }
    if ((access.organization ?? 'required') === 'required' && principal.organizationId === null) {
      throw forbidden('auth.organization-required', 'This route requires an organization.');
    }
    request[PRINCIPAL_PROPERTY] = principal;
    return true;
  }
  // #endregion
}

/**
 * Class OrganizationContextInterceptor
 *
 * @description
 * Runs the handler of a request inside the organization context of its verified principal, so
 * use cases, the transaction runners and the logs read the organization from one place. A
 * request without a verified principal runs without a context.
 */
@Injectable()
export class OrganizationContextInterceptor implements NestInterceptor {
  // #region Methods
  /**
   * Method intercept
   *
   * @description
   * Subscribes to the rest of the pipeline inside the organization context.
   *
   * @param {ExecutionContext} context - Execution context of the request.
   * @param {CallHandler} next - Rest of the request pipeline.
   * @returns {Observable<unknown>} The response stream.
   */
  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const principal: InternalPrincipal | undefined = principalOf(
      context.switchToHttp().getRequest<object>(),
    );
    if (principal === undefined) {
      return next.handle();
    }
    return new Observable<unknown>((subscriber: Subscriber<unknown>) =>
      runWithOrganizationContext(
        {
          organizationId: principal.organizationId,
          actor: principal.actor,
          role: principal.role,
          scopes: principal.scopes,
        },
        () => next.handle().subscribe(subscriber),
      ),
    );
  }
  // #endregion
}
