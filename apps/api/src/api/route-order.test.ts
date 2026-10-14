/**
 * A literal segment must win over a parameter at the same depth.
 *
 * Hono matches in registration order, and the generator once sorted the table
 * alphabetically — which puts `:id` before `facets`, so `/api/activity/facets`
 * would have been answered by the `:id` handler with `id = "facets"`. A parity
 * test would have caught it for that one route; this catches the class.
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { ROUTES } from "./routes.generated";
import { createApiApp } from "./app";

describe("a known path with an unknown method", () => {
  it("is a 405 on that path, not a fall-through to a parameter sibling", async () => {
    // Hono matches method+path per route; the handlers assume path-first
    // resolution. Both groups that hold literal/param siblings found this
    // independently:
    // DELETE /api/tokens/user reached /api/tokens/:id with id="user".
    const app = createApiApp({ serve: ["/api/tokens"] });
    const res = await app.request("/api/tokens/user", { method: "DELETE" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("GET");
    expect(res.headers.get("allow")).toContain("POST");
  });

  it("answers an undefined OPTIONS with 204 and Allow, as Next does", async () => {
    const app = createApiApp({ serve: ["/api/activity"] });
    const res = await app.request("/api/activity/facets", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("does not shadow a route's own methods", async () => {
    const app = createApiApp({ serve: ["/api/health"] });
    expect((await app.request("/api/health")).status).toBe(200);
  });
});

describe("route registration order", () => {
  it("registers every literal before any parameter at the same depth", () => {
    const seenParamAtDepth = new Map<string, number>(); // prefix -> index of first :param
    ROUTES.forEach((route, index) => {
      const segs = route.path.split("/");
      for (let d = 1; d < segs.length; d++) {
        const prefix = segs.slice(0, d).join("/");
        const seg = segs[d]!;
        if (seg.startsWith(":")) {
          if (!seenParamAtDepth.has(prefix)) seenParamAtDepth.set(prefix, index);
        } else if (seenParamAtDepth.has(prefix)) {
          expect.fail(
            `${route.path} is registered after a parameter sibling under ${prefix}/ ` +
              `and would be shadowed by it for shared methods`,
          );
        }
      }
    });
  });

  it("proves the shadowing is real, on a toy app, so the rule above is not folklore", async () => {
    const wrong = new Hono();
    wrong.get("/x/:id", (c) => c.text(`id=${c.req.param("id")}`));
    wrong.get("/x/facets", (c) => c.text("facets"));
    expect(await (await wrong.request("/x/facets")).text()).toBe("id=facets");

    const right = new Hono();
    right.get("/x/facets", (c) => c.text("facets"));
    right.get("/x/:id", (c) => c.text(`id=${c.req.param("id")}`));
    expect(await (await right.request("/x/facets")).text()).toBe("facets");
  });
});
