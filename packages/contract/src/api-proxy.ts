/**
 * The rewrites that send API traffic from the web app to the API process.
 *
 * One rewrite per API route, never per prefix — the first version expanded
 * "/" into `/:path*` and proxied every page to a process that has no pages.
 * The route list is generated into this package by the API repo
 * (`api-paths.generated.ts`), so the web side proxies exactly what exists
 * and nothing else. Hono and Next spell dynamic segments the same way
 * (`:id`), so a route path is a valid rewrite source as it is.
 *
 * `served` narrows the list by path prefix — the web passes ["/"] (everything);
 * the API's own tests use `isServed` to mount one route group in isolation.
 */
import { ROUTE_PATHS } from "./api-paths.generated.js";

export { ROUTE_PATHS };

export function isServed(path: string, served: readonly string[]): boolean {
  return served.some((p) => p === "/" || path === p || path.startsWith(p + "/"));
}

export function apiRewrites(
  apiOrigin: string | undefined,
  served: readonly string[] = ["/"],
  routePaths: readonly string[] = ROUTE_PATHS,
): Array<{ source: string; destination: string }> {
  const origin = apiOrigin?.replace(/\/$/, "");
  if (!origin) return [];
  return routePaths
    .filter((path) => isServed(path, served))
    .map((path) => ({ source: path, destination: `${origin}${path}` }));
}
