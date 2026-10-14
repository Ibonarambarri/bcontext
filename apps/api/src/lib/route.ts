/**
 * Route wrapper that establishes the request-id / correlation-id context,
 * logs the lifecycle, and attaches the IDs to every response. Wrap each
 * route handler:
 *
 *   export const POST = withRoute(async (req) => { ... });
 *
 * Inside the handler, `requestId()` and `correlationId()` from
 * `@/lib/correlation` resolve to the current IDs. Outside, `log.info(...)`
 * automatically picks them up via AsyncLocalStorage.
 *
 * It is also where REST errors enter the error pipeline. The catch below
 * already decided which throws are failures and which are outcomes; the
 * reporter reuses that decision rather than making a second one, so an
 * out-of-reach node never shows up in the panel as a bug.
 */
import { ForbiddenError, NodeOutOfReachError } from "@/lib/storage/scoped";
import { reportApiError } from "@/lib/errors/report";
import { idsFromRequest, requestAnnotations, runWithIds } from "@bcontext-dev/contract/correlation";
import { log } from "@bcontext-dev/contract/log";

type Handler<TArgs extends unknown[]> = (
  req: Request,
  ...args: TArgs
) => Promise<Response>;

const UUID_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Opaque, high-entropy segments that are ids by construction: invite tokens,
 *  OAuth client ids, nanoids. Long enough that no route literal collides. */
const OPAQUE_SEGMENT = /^[A-Za-z0-9_-]{21,}$/;

/**
 * The pathname with its variable parts collapsed, so that four thousand
 * requests to four thousand node ids are one operation and not four thousand.
 *
 * The grouping key of the whole error table is `operation`, and an operation
 * that embeds a UUID groups nothing: every event would be its own problem and
 * the panel would be a log viewer with extra steps. Hence `:id` rather than
 * the URL.
 *
 * This works on the pathname because that is all a framework-neutral handler
 * gets — there is no route object to ask. The consequence is a known limit:
 * a *slug* segment (`/api/organizations/acme`) is indistinguishable from a
 * literal (`/api/organizations/health`) and is left alone. That is the right
 * failure: an over-split group is annoying, a wrongly-merged one is wrong.
 */
export function routePattern(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  return normalized
    .split("/")
    .map((segment) => {
      if (!segment) return segment;
      if (UUID_SEGMENT.test(segment)) return ":id";
      // Numeric ids. `/v1` and friends stay literal because they are not
      // bare digits.
      if (/^\d+$/.test(segment)) return ":id";
      if (OPAQUE_SEGMENT.test(segment) && /\d/.test(segment)) return ":id";
      return segment;
    })
    .join("/");
}

/** Wraps a handler as described above; every exported route method should go through it. */
export function withRoute<TArgs extends unknown[]>(
  handler: Handler<TArgs>,
): Handler<TArgs> {
  return async (req, ...args) => {
    const ids = idsFromRequest(req);
    const url = new URL(req.url);
    return runWithIds(ids, async () => {
      const started = Date.now();
      log.info("request.started", {
        method: req.method,
        path: url.pathname,
      });
      try {
        const res = await handler(req, ...args);
        const durationMs = Date.now() - started;
        res.headers.set("x-request-id", ids.requestId);
        res.headers.set("x-correlation-id", ids.correlationId);
        res.headers.append("server-timing", `app;dur=${durationMs}`);
        // Whatever the handler learned on the way — for `/mcp`, which tool
        // ran and for which kind of principal — rides on the same line, so
        // "what do agents use" is one grep instead of a join across events.
        // The fixed keys come last: an annotation can add, never overwrite.
        log.info("request.completed", {
          ...requestAnnotations(),
          method: req.method,
          path: url.pathname,
          status: res.status,
          duration_ms: durationMs,
        });
        return res;
      } catch (err) {
        // Reach denials are expected outcomes, not failures. Left to fall
        // through they became 500s, which is worse than wrong: a missing node
        // id returns 404 and an out-of-reach one returned 500, so the pair was
        // an existence oracle — the exact thing the scoped storage reports as
        // "missing" precisely to avoid.
        //
        // Neither is reported either, for the same reason they are not logged
        // as failures: a panel that fills up with permission checks doing
        // their job is a panel nobody opens.
        if (err instanceof NodeOutOfReachError) {
          return Response.json({ error: "not_found" }, { status: 404 });
        }
        if (err instanceof ForbiddenError) {
          return Response.json({ error: "forbidden", verb: err.verb }, { status: 403 });
        }
        const durationMs = Date.now() - started;
        log.error("request.failed", {
          ...requestAnnotations(),
          method: req.method,
          path: url.pathname,
          duration_ms: durationMs,
          error: {
            message: err instanceof Error ? err.message : String(err),
          },
        });
        // Same event, second destination. The log line is what you grep when
        // you already know something is wrong; this is what tells you.
        reportApiError({
          operation: `rest:${req.method} ${routePattern(url.pathname)}`,
          error: err,
          status_code: 500,
          duration_ms: durationMs,
          path: url.pathname,
          method: req.method,
          user_agent: req.headers.get("user-agent") ?? undefined,
        });
        // Build a generic 500 with IDs so the caller can correlate.
        return Response.json(
          { error: "internal" },
          {
            status: 500,
            headers: {
              "x-request-id": ids.requestId,
              "x-correlation-id": ids.correlationId,
            },
          },
        );
      }
    });
  };
}
