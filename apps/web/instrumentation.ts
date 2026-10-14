/**
 * Next.js instrumentation hooks — the two functions Next calls by name.
 *
 * `register` runs once per server start in both the Node and Edge runtimes;
 * it prints the env validation status so a misconfigured container says so
 * in its first log lines. `onRequestError` is the web app's only server-side
 * entry into error telemetry (see below).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { logEnvStatus } = await import("@bcontext-dev/contract/env");
    logEnvStatus();

  }
}

/**
 * Next.js error hook — fires for uncaught errors in Server Components, Server
 * Actions and route handlers (anything a route's own `error.tsx` did not catch).
 * We log them through the structured logger (which forwards to Better Stack
 * when configured) and flush before returning since the request is already
 * unwinding.
 *
 * It is also this repo's only server-side entry into the error collector, and
 * that is not an accident: this app has no data of its own and therefore
 * almost no try/catch worth instrumenting. Everything that breaks here breaks
 * while rendering a route, and Next hands us the route *pattern*
 * (`context.routePath`, e.g. `/w/[org]/[ws]`) rather than the URL — which is
 * exactly the grouping key the panel wants, for free. `request.path` is the
 * concrete URL and rides along as `path` for the one-row view.
 *
 * The reporter is imported lazily and built per call. This hook runs on the
 * Edge runtime too, where a module-scope singleton reading `process.env` is a
 * liability, and the cost is a closure on a path that is already failing.
 */
export async function onRequestError(
  err: unknown,
  request: { path?: string; method?: string; headers?: Record<string, string | undefined> },
  context: { routerKind?: string; routePath?: string; renderSource?: string },
): Promise<void> {
  const { log } = await import("@bcontext-dev/contract/log");
  log.error("request.unhandled", {
    method: request.method,
    path: request.path ?? context.routePath,
    router: context.routerKind,
    source: context.renderSource,
    error: {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    },
  });
  // Second destination, never a second failure: an unreachable collector must
  // not turn one broken render into a throw inside Next's own error hook.
  try {
    const { createErrorReporter } = await import("@bcontext-dev/contract/error-report");
    const report = createErrorReporter("web");
    if (report.enabled) {
      report({
        operation: `web.route:${context.routePath ?? request.path ?? "unknown"}`,
        error: err,
        path: request.path,
        method: request.method,
        user_agent: request.headers?.["user-agent"],
        context: {
          router_kind: context.routerKind,
          route_path: context.routePath,
          render_source: context.renderSource,
        },
      });
    }
  } catch {
    // Telemetry is never the reason a request handler throws.
  }
  await log.flush();
}
