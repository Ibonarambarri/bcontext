import { describe, expect, it } from "vitest";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { GET } from "./route";
import { PATCH } from "../route";

const headers = { origin: "http://localhost", host: "localhost", "content-type": "application/json" };

function request(path: string, method = "GET", body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("node inspector API", () => {
  it("returns one permission-scoped snapshot with exact H2 links and dependencies", async () => {
    const workspace = createWorkspace({ name: "Inspector", slug: `inspector-${Date.now()}-${Math.random()}` });
    const storage = resolveDemoStorage(workspace.slug)!;
    const target = await storage.createNode({ title: "Target", kind: "task", parent_id: null, content_md: "## Goal\n\nShip it" });
    const source = await storage.createNode({ title: "Source", kind: "doc", parent_id: null, content_md: `See /n/${target.id}#goal` });
    await storage.createEdge({ from_node: target.id, to_node: source.id, relation: "blocked_by" });

    const response = await GET(
      request(`/api/nodes/${target.id}/inspector?workspace=${workspace.slug}`),
      { params: Promise.resolve({ id: target.id }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.permissions).toEqual({ read: true, write: true });
    expect(body.backlinks[0]).toMatchObject({ id: source.id, block_id: "goal" });
    expect(body.dependencies.blocked_by[0]).toMatchObject({ node_id: source.id });
    expect(body.graph.nodes.some((item: { id: string }) => item.id === target.id)).toBe(true);
  });

  it("serves a light preview scope and slim activity rows", async () => {
    const workspace = createWorkspace({ name: "Preview", slug: `preview-${Date.now()}-${Math.random()}` });
    const storage = resolveDemoStorage(workspace.slug)!;
    const target = await storage.createNode({ title: "Preview me", kind: "doc", parent_id: null, content_md: "## Intro\n\nHello" });
    const neighbour = await storage.createNode({ title: "Linked", kind: "doc", parent_id: null, content_md: `See /n/${target.id}` });
    await storage.createEdge({ from_node: target.id, to_node: neighbour.id, relation: "relates_to" });

    const preview = await GET(
      request(`/api/nodes/${target.id}/inspector?workspace=${workspace.slug}&scope=preview`),
      { params: Promise.resolve({ id: target.id }) },
    );
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expect(previewBody.node.id).toBe(target.id);
    expect(previewBody.node.content_md).toContain("Hello");
    // Preview skips the context reads entirely.
    expect(previewBody.backlinks).toEqual([]);
    expect(previewBody.relations).toEqual([]);
    expect(previewBody.activity).toEqual([]);

    const full = await GET(
      request(`/api/nodes/${target.id}/inspector?workspace=${workspace.slug}`),
      { params: Promise.resolve({ id: target.id }) },
    );
    const fullBody = await full.json();
    expect(fullBody.relations.length).toBeGreaterThan(0);
    // Inspector activity rows never carry before/after markdown snapshots.
    for (const entry of fullBody.activity as Array<{ before: unknown; after: unknown }>) {
      expect(entry.before).toBeNull();
      expect(entry.after).toBeNull();
    }
  });

  it("rejects stale quick edits with optimistic concurrency", async () => {
    const workspace = createWorkspace({ name: "Conflict", slug: `conflict-${Date.now()}-${Math.random()}` });
    const storage = resolveDemoStorage(workspace.slug)!;
    const created = await storage.createNode({ title: "Original", kind: "task", parent_id: null });
    await storage.updateNode(created.id, { title: "Concurrent" });

    const response = await PATCH(
      request(`/api/nodes/${created.id}`, "PATCH", {
        workspace: workspace.slug,
        if_updated_at: "2000-01-01T00:00:00.000Z",
        title: "Stale edit",
      }),
      { params: Promise.resolve({ id: created.id }) },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "conflict" });
  });
});
