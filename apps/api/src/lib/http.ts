/**
 * Web-standard response helpers for route handlers.
 *
 * `Response.redirect()` comes back with immutable headers and `withRoute`
 * sets `x-request-id` on every response — so the standard call would throw
 * on the first redirect. `redirectTo()` builds the response by hand and keeps
 * the 307 that `Response.redirect` defaulted to, which the connector
 * callbacks rely on.
 */
export function redirectTo(url: string | URL, status: 301 | 302 | 303 | 307 | 308 = 307): Response {
  return new Response(null, { status, headers: { location: String(url) } });
}
