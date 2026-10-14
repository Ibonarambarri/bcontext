import { describe, expect, it } from "vitest";
import { createApiApp } from "./app";

describe("api process", () => {
  const app = createApiApp();

  it("answers liveness without touching anything", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, process: "api" });
  });

  it("serves the health route through the route table", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    // The route's own contract, not Hono's: no-store, because uptime pings
    // must never be answered from a cache.
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});
