/**
 * The origin the person actually has in the address bar, for redirects built
 * inside a Route Handler.
 *
 * `new URL(req.url).origin` is not that: the standalone server in production
 * binds to `HOSTNAME=0.0.0.0` behind Traefik and reports itself as
 * `http://0.0.0.0:3000`, so a redirect built from it sends the browser to a
 * host that only exists inside the container. The proxy passes the public
 * host and scheme in `x-forwarded-*`, which is what `api-client.ts` already
 * relies on for the same-origin guard; in local dev there is no proxy and
 * `host` is the real one. Used by `auth/signout` and `auth/callback`, the two
 * routes this app serves itself and that end in a redirect.
 */
export function publicOrigin(req: Request): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!host) return new URL(req.url).origin;
  const proto =
    req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ??
    new URL(req.url).protocol.replace(/:$/, "");
  return `${proto}://${host}`;
}

/**
 * The origin this instance answers on, for links built where there is no
 * `Request` object — server actions, `robots.ts`, `sitemap.ts`, the OAuth
 * consent page — given the incoming headers (`await headers()`).
 *
 * `NEXT_PUBLIC_APP_URL` wins when it is set, so a proxy in front cannot
 * change what counts as "ours" (the API advertises the MCP resource from the
 * same URL). Without it the forwarded host and scheme do, then `Host`, so a
 * self-hosted instance works on whatever domain it is served from without
 * any domain baked into the code.
 */
export function appOrigin(headers: Headers): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? "localhost:3000";
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  return `${proto}://${host}`;
}
