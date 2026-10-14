/**
 * Serving a route module (a `route.ts` under `src/app`) from Hono.
 *
 * A route module exports `GET`, `POST`, … as `(req, ctx?) => Promise<Response>`,
 * where `ctx.params` is a promise of the dynamic segments — the file
 * convention the handlers were born under and kept. They touch nothing but
 * `Request` and `Response` (`routes-are-framework-neutral.test.ts` guards
 * it), so serving one from Hono is a matter of handing it `c.req.raw` and
 * the params in the shape it expects.
 *
 * Deliberately no translation layer beyond that. If a route needs anything
 * Hono-specific to work here, the route is coupled to something and the fix
 * belongs in the route, where the neutrality guard will point at it.
 */
import type { Hono } from "hono";

export type RouteHandler = (
  req: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

export type RouteModule = Partial<
  Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS", RouteHandler>
>;

export function mountRoute(
  app: Hono,
  path: string,
  methods: readonly string[],
  module: RouteModule,
): void {
  const mounted: string[] = [];
  for (const method of methods) {
    const handler = module[method as keyof RouteModule];
    if (!handler) continue;
    mounted.push(method);
    app.on(method, path, (c) => handler(c.req.raw, { params: Promise.resolve(c.req.param()) }));
  }

  // The handlers assume path-first resolution: a request for a path that
  // exists with other methods is a 405 (and an undefined OPTIONS is a 204 with
  // Allow). Hono matches method+path per route and would keep looking, so
  // `DELETE /api/tokens/user` fell through to `/api/tokens/:id` with
  // id="user" — two parity groups noticed independently. Registering the
  // catch-all right after the route's own methods, and before any sibling,
  // gives the path those semantics.
  const allow = [...new Set([...mounted, ...(mounted.includes("GET") ? ["HEAD"] : []), "OPTIONS"])].join(", ");
  app.all(path, (c) => {
    if (c.req.method === "OPTIONS") return new Response(null, { status: 204, headers: { allow } });
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow } });
  });
}
