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
import {
  assertConsistentContext,
  InternalTokenVerifier,
  type InternalPrincipal,
} from './internal-token.js';
import {
  runWithOrganizationContext,
  type InternalActorType,
  type OrganizationContext,
} from './organization-context.js';

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
 * Constant ATTACHED_CONTEXT
 *
 * @description
 * Request property holding the organization context attached by `setRequestOrganizationContext`.
 * A symbol private to this module: nothing else, and no request data, can set it.
 *
 * @type {symbol}
 */
const ATTACHED_CONTEXT: unique symbol = Symbol('cadenway.request-organization-context');

/**
 * Constant contextOpened
 *
 * @description
 * Requests whose handler already runs inside the organization context, so a second registration
 * of `OrganizationContextInterceptor` (the one of `createApplication` and the one of
 * `InternalTokenModule`) opens it only once.
 *
 * @type {WeakSet<object>}
 */
const contextOpened: WeakSet<object> = new WeakSet<object>();

/**
 * Function InternalAccess
 *
 * @description
 * Declares what a controller or a route accepts from the internal token, when the defaults (an
 * organization, no anonymous actor, any trusted issuer) do not fit. A declaration on a method
 * is merged over the one on its class: each option it sets replaces the class one, the others
 * are kept.
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
 * Function setRequestOrganizationContext
 *
 * @description
 * Sets the organization context of an HTTP request whose caller was verified by the application
 * itself rather than by the internal token: a public gateway, after it introspected a session or
 * checked an API token. `OrganizationContextInterceptor` then runs the handler inside it, so
 * `getOrganizationContext()`, the transaction runners, `InternalHttpClient` and the logs read it
 * as they read the context of an internal token.
 *
 * Call it only from the code that verified the caller, usually its guard, and only with what that
 * verification returned: never with a value read from the request (path, query string, body or
 * headers). Besides the internal token, it is the only sanctioned way to give an HTTP request an
 * identity; `runWithOrganizationContext` is not one.
 *
 * A request has one source of identity: it throws when the request already carries an attached
 * context or a principal verified by `InternalTokenGuard`. It also throws for a context the
 * internal token could not carry (an organization id that is not a UUID, an anonymous actor with
 * an id, an organization, a role or scopes, an identified actor without an id).
 *
 * @param {object} request - Incoming request, as handed to the guard.
 * @param {OrganizationContext} context - Organization, actor, member role and scopes established by the verification.
 * @returns {void}
 * @throws {Error} When the request already has an identity or the context is inconsistent: a programming error.
 */
export function setRequestOrganizationContext(request: object, context: OrganizationContext): void {
  const holder: { [ATTACHED_CONTEXT]?: OrganizationContext } = request;
  if (principalOf(request) !== undefined) {
    throw new Error(
      'setRequestOrganizationContext: the request carries a verified internal token; it has its identity already.',
    );
  }
  if (holder[ATTACHED_CONTEXT] !== undefined) {
    throw new Error(
      'setRequestOrganizationContext: the request already carries an organization context.',
    );
  }
  assertConsistentContext(context);
  holder[ATTACHED_CONTEXT] = Object.freeze({
    organizationId: context.organizationId,
    actor: Object.freeze({ type: context.actor.type, id: context.actor.id }),
    role: context.role,
    scopes: Object.freeze([...context.scopes]),
  });
}

/**
 * Function requestOrganizationContextOf
 *
 * @description
 * Reads the identity of a request from its one source: the principal verified by
 * `InternalTokenGuard`, otherwise the context attached by `setRequestOrganizationContext`.
 * Internal to the package; applications read `getOrganizationContext()`.
 *
 * @param {object} request - Incoming request.
 * @returns {OrganizationContext | undefined} The organization context of the request, or `undefined` when it has none.
 */
export function requestOrganizationContextOf(request: object): OrganizationContext | undefined {
  const principal: InternalPrincipal | undefined = principalOf(request);
  if (principal !== undefined) {
    return {
      organizationId: principal.organizationId,
      actor: principal.actor,
      role: principal.role,
      scopes: principal.scopes,
    };
  }
  return (request as { [ATTACHED_CONTEXT]?: OrganizationContext })[ATTACHED_CONTEXT];
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
    // Merged, not overridden: a restriction declared on the controller, such as its issuers,
    // must survive a route that only changes the accepted actors.
    const access: InternalAccessOptions = {
      ...this.reflector.get<InternalAccessOptions | undefined>(
        INTERNAL_ACCESS_KEY,
        context.getClass(),
      ),
      ...this.reflector.get<InternalAccessOptions | undefined>(
        INTERNAL_ACCESS_KEY,
        context.getHandler(),
      ),
    };
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
 * Runs the handler of a request inside its organization context, so use cases, the transaction
 * runners and the logs read the organization from one place. The context comes from the
 * principal verified by `InternalTokenGuard` when there is one, otherwise from the context the
 * application attached with `setRequestOrganizationContext`; a request with neither runs without
 * a context.
 *
 * Registered more than once (by `createApplication` and by `InternalTokenModule`), it opens the
 * context once per request: the outermost registration does, the others pass through.
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
    const request: object = context.switchToHttp().getRequest<object>();
    const organizationContext: OrganizationContext | undefined =
      requestOrganizationContextOf(request);
    if (organizationContext === undefined || contextOpened.has(request)) {
      return next.handle();
    }
    contextOpened.add(request);
    return new Observable<unknown>((subscriber: Subscriber<unknown>) =>
      runWithOrganizationContext(organizationContext, () => next.handle().subscribe(subscriber)),
    );
  }
  // #endregion
}
