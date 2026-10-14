// @ts-check
// Plain JavaScript on purpose: Node loads it, and the contract package
// resolves through node_modules like any other dependency.
//
// The one job of this config: hand every API route the contract lists to the
// API process (`API_ORIGIN`) so the browser can keep calling `/api/…`, `/mcp`,
// `/.well-known/…` relatively on the web's own origin. The list comes from the
// contract (`api-paths.generated`), so the web proxies exactly what exists.
import { fileURLToPath } from "node:url";
import { apiRewrites, ROUTE_PATHS } from "@bcontext-dev/contract/api-proxy";

/** The monorepo root: dependencies are hoisted there and the contract lives in packages/. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Every route the contract lists is the API's; the web app serves none of them. */
const SERVED = ["/"];

/**
 * Where the API process lives: `http://localhost:4000` locally, the internal
 * service in docker compose (`http://api:4000`). Required — this repo has no API code of
 * its own, so without it every API path 404s. Read at BUILD time: rewrites
 * are baked into the output.
 */
const API_ORIGIN = process.env.API_ORIGIN;

/** @type {import("next").NextConfig} */
const nextConfig = {
  async rewrites() {
    // beforeFiles: the rewrites must win over anything under src/app for the
    // same paths (today only `api/client-errors`, which the contract does not
    // list), or Next answers itself and the API process never sees the request.
    return { beforeFiles: apiRewrites(API_ORIGIN, SERVED, ROUTE_PATHS), afterFiles: [], fallback: [] };
  },
  reactStrictMode: true,
  typedRoutes: true,
  // Self-contained server bundle (.next/standalone) — the app runs as a plain
  // Node container, no vendor-specific runtime. Traced from the repo root so
  // hoisted workspace dependencies are included.
  output: "standalone",
  outputFileTracingRoot: REPO_ROOT,
  turbopack: { root: REPO_ROOT },
};

export default nextConfig;
