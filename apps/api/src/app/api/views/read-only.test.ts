/**
 * A read-only grant must not create, modify, duplicate or delete saved views
 * over REST, exactly as `views_write` over MCP refuses it. The demo backend
 * hands every caller a system grant, so the workspace boundary is wrapped
 * here to behave like a member whose grant carries only `read`: reads go
 * through untouched, anything else is refused with the verb it lacked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/workspace")>();
  return {
    ...actual,
    openWorkspace: async (...args: Parameters<typeof actual.openWorkspace>) => {
      const verb = args[2];
      if (verb !== "read") return Response.json({ error: "forbidden", verb }, { status: 403 });
      return actual.openWorkspace(...args);
    },
  };
});

import { createWorkspace } from "@/lib/demo-store";
import { resetDemoViewsForTests } from "@/lib/views/store";
import { GET, POST } from "./route";
import { GET as GET_ONE, PATCH, DELETE } from "./[id]/route";
import { POST as DUPLICATE } from "./[id]/duplicate/route";

const headers = { "content-type": "application/json", origin: "http://localhost", host: "localhost" };
function request(path: string, method = "GET", body?: unknown) {
  return new Request(`http://localhost${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const query = { schema_version: 1 as const };
const presentation = { schema_version: 1 as const, renderer: "list" as const };

describe("REST saved views with a read-only grant", () => {
  let slug: string;
  beforeEach(() => {
    resetDemoViewsForTests();
    slug = createWorkspace({ name: "Read-only views", slug: `ro-views-${Date.now()}-${Math.random()}` }).slug;
  });

  it("still lists and reads views", async () => {
    const listed = await GET(request(`/api/views?workspace=${slug}`));
    expect(listed.status).toBe(200);
    const { views } = (await listed.json()) as { views: Array<{ id: string }> };
    const one = await GET_ONE(request(`/api/views/${views[0]!.id}?workspace=${slug}`), { params: Promise.resolve({ id: views[0]!.id }) });
    expect(one.status).toBe(200);
  });

  it("gets 403 on POST /api/views", async () => {
    const res = await POST(request("/api/views", "POST", { workspace: slug, name: "Mine", query, presentation }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden", verb: "write" });
  });

  it("gets 403 on PATCH, DELETE and duplicate too", async () => {
    const listed = await GET(request(`/api/views?workspace=${slug}`));
    const { views } = (await listed.json()) as { views: Array<{ id: string }> };
    const id = views[0]!.id;
    const ctx = { params: Promise.resolve({ id }) };
    expect((await PATCH(request(`/api/views/${id}`, "PATCH", { workspace: slug, expected_version: 1, name: "Renamed" }), ctx)).status).toBe(403);
    expect((await DELETE(request(`/api/views/${id}?workspace=${slug}&expected_version=1`, "DELETE"), ctx)).status).toBe(403);
    expect((await DUPLICATE(request(`/api/views/${id}/duplicate`, "POST", { workspace: slug }), ctx)).status).toBe(403);
  });
});
