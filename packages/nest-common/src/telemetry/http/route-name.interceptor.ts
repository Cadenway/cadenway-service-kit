import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { context as otelContext, trace, type Span } from '@opentelemetry/api';
import { getRPCMetadata, RPCType, type RPCMetadata } from '@opentelemetry/core';
import { ATTR_HTTP_ROUTE } from '@opentelemetry/semantic-conventions';
import type { Observable } from 'rxjs';

import { routePatternOf } from '../../http/routing/route.js';

/**
 * Function nameHttpSpan
 *
 * @description
 * Names the server span of the current request `<METHOD> <route>` and sets its `http.route`
 * attribute. The route is also handed to the HTTP instrumentation, which copies it onto the
 * request duration metric. Does nothing outside a traced request.
 *
 * @param {string} method - HTTP method of the request.
 * @param {string} route - Route pattern, such as `/internal/v1/tasks/:taskId`.
 * @returns {void}
 */
export function nameHttpSpan(method: string, route: string): void {
  const metadata: RPCMetadata | undefined = getRPCMetadata(otelContext.active());
  const span: Span | undefined =
    metadata?.type === RPCType.HTTP ? metadata.span : trace.getActiveSpan();
  if (metadata?.type === RPCType.HTTP) {
    metadata.route = route;
  }
  span?.updateName(`${method} ${route}`);
  span?.setAttribute(ATTR_HTTP_ROUTE, route);
}

/**
 * Class RouteNameInterceptor
 *
 * @description
 * Names the span of each HTTP request after the NestJS route that handles it and sets
 * `http.route`: no OpenTelemetry instrumentation supports NestJS 12, so without it a span would
 * keep the bare method as its name. Requests that match no route are left untouched.
 */
@Injectable()
export class RouteNameInterceptor implements NestInterceptor {
  // #region Methods
  /**
   * Method intercept
   *
   * @description
   * Names the current span, then lets the request continue unchanged.
   *
   * @param {ExecutionContext} context - Execution context of the request.
   * @param {CallHandler} next - Rest of the request pipeline.
   * @returns {Observable<unknown>} The untouched response stream.
   */
  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const request: { method?: string } = context.switchToHttp().getRequest();
      const route: string | null = routePatternOf(request);
      if (route !== null) {
        nameHttpSpan(request.method ?? 'GET', route);
      }
    }
    return next.handle();
  }
  // #endregion
}
