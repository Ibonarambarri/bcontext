import { describe, expect, it } from "vitest";
import { apiRewrites } from "@bcontext-dev/contract/api-proxy";
import { ROUTE_PATHS } from "./paths.generated";

describe("apiRewrites", () => {
  it("proxies routes, never pages, even when everything is served", () => {
    const rewrites = apiRewrites("http://api:4000", ["/"], ROUTE_PATHS);
    const sources = new Set(rewrites.map((r) => r.source));
    expect(sources.size).toBe(ROUTE_PATHS.length);
    // The pages the web app renders itself. Proxying any of these is the
    // outage the first version would have caused.
    for (const page of ["/", "/login", "/workspaces", "/w/:ws", "/w/:ws/n/:nodeId", "/docs"]) {
      expect(sources.has(page), `${page} must stay on Next`).toBe(false);
    }
    expect(sources.has("/mcp")).toBe(true);
    expect(sources.has("/api/nodes/:id")).toBe(true);
  });

  it("narrows to the served prefixes", () => {
    const sources = apiRewrites("http://api:4000", ["/api/health"], ROUTE_PATHS).map((r) => r.source);
    expect(sources).toEqual(["/api/health"]);
  });

  it("is empty without an origin", () => {
    expect(apiRewrites(undefined, ["/"], ROUTE_PATHS)).toEqual([]);
    expect(apiRewrites("", ["/"], ROUTE_PATHS)).toEqual([]);
  });

  it("keeps the browser-only auth routes on Next", () => {
    const sources = apiRewrites("http://api:4000", ["/"], ROUTE_PATHS).map((r) => r.source);
    expect(sources).not.toContain("/auth/callback");
    expect(sources).not.toContain("/auth/signout");
  });
});
