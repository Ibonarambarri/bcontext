/**
 * Same-origin guard for state-changing requests served from session
 * cookies. Bearer-token requests are exempt because machine clients
 * legitimately set arbitrary Origins (or none at all).
 *
 * Allowed extra origins can be configured via ALLOWED_ORIGINS (legacy NEXT_PUBLIC_ALLOWED_ORIGINS)
 * (comma-separated hostnames or origins).
 */

import { allowedOrigins, appUrl } from "@/lib/env";

const STATE_CHANGING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

// Routes that are bearer/OAuth only — never session-cookied — and must be
// reachable by non-browser MCP clients that don't send an Origin header.
// Skipping the same-origin check here is safe because there are no cookies
// to ride along on a CSRF attempt.
const BEARER_ONLY_PATHS = new Set([
  "/mcp",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/api/oauth/token",
  "/api/oauth/register",
]);

export function assertSameOrigin(req: Request): Response | null {
  if (!STATE_CHANGING.has(req.method)) return null;

  // Bearer-only endpoints: MCP clients legitimately POST here without any
  // Origin header. CSRF doesn't apply because the routes don't read cookies.
  try {
    const pathname = new URL(req.url).pathname;
    if (BEARER_ONLY_PATHS.has(pathname)) return null;
    // The per-workspace MCP endpoint (`/mcp/<org>/<workspace>`) is the same
    // bearer-only surface under a longer path: an MCP client's first POST
    // there carries neither token nor Origin and must reach the 401 that
    // advertises OAuth discovery.
    if (pathname.startsWith("/mcp/")) return null;
  } catch {
    // fall through — let the normal check run
  }

  // Bearer-token requests bypass: machine clients are authenticated by the
  // token alone, not by the browser's same-origin guarantees.
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) return null;

  const originHeader =
    req.headers.get("origin") ?? req.headers.get("referer");
  if (!originHeader) {
    return Response.json(
      { error: "origin_required" },
      { status: 403 },
    );
  }

  let originHost: string;
  try {
    originHost = new URL(originHeader).host;
  } catch {
    return Response.json(
      { error: "origin_invalid" },
      { status: 403 },
    );
  }

  // Behind the web app's proxy to the API, `host` is the internal address of the
  // API process and the browser's host arrives as `x-forwarded-host`. Measured,
  // not assumed: host=localhost:4000, origin=http://localhost:3000,
  // x-forwarded-host=localhost:3000. Comparing origin against `host` there
  // would 403 every browser write. Trusting the forwarded header is safe for
  // what this guard defends against: a cross-site request cannot carry it
  // without a CORS preflight, and a form post cannot carry it at all — the same
  // browser guarantee the whole check rests on.
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const allowed = new Set<string>([host, `www.${host}`]);

  // The web is a different host from the API in production (app.example.com
  // calling api.example.com), and the reverse proxy in front of the API
  // rewrites `x-forwarded-host` to its own name — so the forwarded header
  // says "api", the browser's Origin says "app", and every fetch the client
  // makes is refused while server actions, which carry no Origin at all,
  // sail through. The API already declares where the app lives in order to
  // build invitation links; the same value is the origin its browser
  // requests come from, so it is trusted here rather than duplicated into a
  // second variable somebody has to remember to set.
  const declared = appUrl();
  if (declared) {
    try {
      allowed.add(new URL(declared).host);
    } catch {
      /* a malformed URL configures nothing rather than opening everything */
    }
  }

  const extra = allowedOrigins();
  if (extra) {
    for (const raw of extra.split(",")) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        allowed.add(new URL(trimmed).host);
      } catch {
        allowed.add(trimmed); // raw hostname
      }
    }
  }

  if (!allowed.has(originHost)) {
    return Response.json(
      { error: "origin_mismatch" },
      { status: 403 },
    );
  }
  return null;
}
