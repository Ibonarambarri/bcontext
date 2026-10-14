/**
 * The API process: every handler in the generated route table, mounted on
 * Hono, plus the process-level routes (`/healthz`, `/realtime/*`).
 */
import { Hono } from "hono";
import { isServed } from "@bcontext-dev/contract/api-proxy";
import { mountRoute } from "./adapter";
import { ROUTES } from "./routes.generated";
import { getHub, type WorkspaceEvent } from "@/lib/realtime/hub";
import { publishWorkspaceEvent } from "@/lib/realtime/publish";

export interface ApiAppOptions {
  /**
   * Mount only the routes under these path prefixes. For tests: a group can
   * be exercised through `app.request()` in isolation, and `[]` gives an app
   * that serves nothing (the parity harness guards itself with it).
   */
  serve?: readonly string[];
}

export function createApiApp(options: ApiAppOptions = {}): Hono {
  const app = new Hono();

  // Liveness for the process itself, distinct from /api/health which also
  // checks the database: a scheduler that only wants "is it up" gets an
  // answer that cannot be dragged down by a slow query.
  app.get("/healthz", (c) => c.json({ ok: true, process: "api" }));

  // Every response says which process produced it — the web app proxies these
  // paths, and "who answered" is the first question when something differs.
  app.use(async (c, next) => {
    await next();
    c.res.headers.set("x-served-by", "api");
  });

  const serve = options.serve;
  const routes = serve ? ROUTES.filter((r) => isServed(r.path, serve)) : ROUTES;
  for (const route of routes) {
    mountRoute(app, route.path, route.methods, route.module);
  }

  // The fallback for a process without `DATABASE_URL`: hand the broadcast to
  // the process that holds the sockets over HTTP, with the shared internal
  // secret (`REALTIME_SECRET`). With the database configured the worker uses
  // Postgres NOTIFY instead (`@/lib/realtime/publish`) and this route idles.
  // The `id` a caller sends is the dedupe key, so an event that arrived on
  // both paths is fanned out once; publishing from here also relays it to the
  // other instances over the channel.
  app.post("/realtime/broadcast", async (c) => {
    if (!internalSecretOk(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
    // Without a hub, publishing would fall back to HTTP — to this very route.
    if (!getHub()) return c.json({ error: "realtime_unavailable" }, 503);
    const body = (await c.req.json().catch(() => null)) as { id?: unknown; workspaceId?: string; event?: WorkspaceEvent } | null;
    if (!body?.workspaceId || !body.event?.kind) return c.json({ error: "invalid_body" }, 400);
    const out = await publishWorkspaceEvent(
      body.workspaceId,
      { ...body.event, ts: body.event.ts ?? Date.now() },
      { id: typeof body.id === "string" && body.id ? body.id : undefined },
    );
    return c.json({ ok: true, delivered: out.local, relay: out.relay });
  });
  app.get("/realtime/stats", (c) => {
    if (!internalSecretOk(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
    return c.json(getHub()?.stats() ?? { workspaces: 0, nodeRooms: 0, connections: 0 });
  });

  app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));

  return app;
}

function internalSecretOk(header: string | undefined): boolean {
  const secret = process.env.REALTIME_SECRET;
  return Boolean(secret) && header === `Bearer ${secret}`;
}
