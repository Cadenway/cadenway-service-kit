import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Observable, type Subscriber } from 'rxjs';

import { runWithOrganizationContext, type OrganizationContext } from './organization-context.js';
import { requestOrganizationContextOf } from './request-organization-context.js';

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
