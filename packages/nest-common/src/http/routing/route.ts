/**
 * Function routePatternOf
 *
 * @description
 * Returns the route pattern matched by a request, such as `/internal/v1/tasks/:taskId`, never its
 * raw URL: a pattern carries no identifier and no query string, so it is safe in a log line, a
 * span name and a metric attribute. The catch-all NestJS registers to answer 404 is not a route.
 *
 * @param {object} request - Incoming request, as Express hands it to NestJS.
 * @returns {string | null} The route pattern, or `null` when no route matched.
 */
export function routePatternOf(request: object): string | null {
  const path: unknown = (request as { route?: { path?: unknown } }).route?.path;
  return typeof path === 'string' && !path.includes('*') ? path : null;
}
