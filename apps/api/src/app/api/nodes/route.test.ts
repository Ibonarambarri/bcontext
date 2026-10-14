import { describe, expect, it } from "vitest";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { GET } from "./route";

function request(path: string) {
  return new Request(`http://localhost${path}`, {
    headers: { origin: "http://localhost", host: "localhost" },
  });
}

describe("GET /api/nodes", () => {
  it("keeps the summary payload contract when no read-shaping params are sent", async () => {
    const workspace = createWorkspace({ name: "Nodes default", slug: `nodes-default-${Date.now()}-${Math.random()}` });
    const storage = resolveDemoStorage(workspace.slug)!;
    await storage.createNode({ title: "One", kind: "doc", parent_id: null, content_md: "# Body" });

    const response = await GET(request(`/api/nodes?workspace=${workspace.slug}`));
    expect(response.status).toBe(200);
    const body = await response.json() as { nodes: Array<Record<string, unknown>>; next_cursor: string | null; fields: string };
    expect(body.fields).toBe("summary");
    expect(body.next_cursor).toBeNull();
    // Summaries never ship bodies, but keep the structural fields.
    expect(body.nodes[0]).toMatchObject({ title: "One", content_md: "" });
    expect(body.nodes[0]).toHaveProperty("data");
  });

  it("serves per-view presets with keyset pagination", async () => {
    const workspace = createWorkspace({ name: "Nodes paged", slug: `nodes-paged-${Date.now()}-${Math.random()}` });
    const storage = resolveDemoStorage(workspace.slug)!;
    for (const title of ["A", "B", "C"]) {
      await storage.createNode({ title, kind: "task", parent_id: null, content_md: "body", status: "todo" });
    }

    const first = await GET(request(`/api/nodes?workspace=${workspace.slug}&fields=list&limit=2`));
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { nodes: Array<Record<string, unknown>>; next_cursor: string | null; fields: string };
    expect(firstBody.fields).toBe("list");
    expect(firstBody.nodes).toHaveLength(2);
    expect(firstBody.next_cursor).not.toBeNull();
    expect(firstBody.nodes[0]).not.toHaveProperty("content_md");
    expect(firstBody.nodes[0]).not.toHaveProperty("data");

    const second = await GET(request(`/api/nodes?workspace=${workspace.slug}&fields=list&limit=2&cursor=${encodeURIComponent(firstBody.next_cursor!)}`));
    const secondBody = await second.json() as { nodes: Array<Record<string, unknown>>; next_cursor: string | null };
    expect(secondBody.nodes).toHaveLength(1);
    expect(secondBody.next_cursor).toBeNull();
    const ids = new Set([...firstBody.nodes, ...secondBody.nodes].map((node) => node.id));
    expect(ids.size).toBe(3);
  });

  it("rejects unknown presets and malformed cursors", async () => {
    const workspace = createWorkspace({ name: "Nodes invalid", slug: `nodes-invalid-${Date.now()}-${Math.random()}` });
    const badFields = await GET(request(`/api/nodes?workspace=${workspace.slug}&fields=everything`));
    expect(badFields.status).toBe(400);
    expect(await badFields.json()).toEqual({ error: "invalid_fields_preset" });
    const badCursor = await GET(request(`/api/nodes?workspace=${workspace.slug}&cursor=nope`));
    expect(badCursor.status).toBe(400);
    expect(await badCursor.json()).toEqual({ error: "invalid_cursor" });
  });
});
