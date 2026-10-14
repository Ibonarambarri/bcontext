import { describe, expect, it } from "vitest";
import { createNode, createWorkspace } from "@/lib/demo-store";
import { GET } from "./route";

/**
 * `?stats=1` is what the hub renders its cards from now that the page no
 * longer counts rows itself. In the demo store every workspace is the
 * caller's own; what is checked here is the card shape and the counting.
 */
describe("GET /api/workspaces?stats=1", () => {
  it("answers plain workspaces without the flag", async () => {
    const ws = createWorkspace({ name: "Plain", slug: `plain-${Date.now()}-${Math.random()}` });
    const res = await GET(new Request("http://localhost/api/workspaces"));
    expect(res.status).toBe(200);
    const { workspaces } = (await res.json()) as { workspaces: Array<Record<string, unknown>> };
    const mine = workspaces.find((w) => w.slug === ws.slug)!;
    expect(mine).toBeDefined();
    expect(mine).not.toHaveProperty("open_task_count");
  });

  it("counts open tasks, nodes, and the latest activity per card", async () => {
    const ws = createWorkspace({ name: "Cards", slug: `cards-${Date.now()}-${Math.random()}` });
    createNode(ws.slug, { title: "Open", kind: "task", parent_id: null, status: "todo" });
    createNode(ws.slug, { title: "Done", kind: "task", parent_id: null, status: "done" });
    const last = createNode(ws.slug, { title: "Doc", kind: "doc", parent_id: null });

    const res = await GET(new Request("http://localhost/api/workspaces?stats=1"));
    expect(res.status).toBe(200);
    const { workspaces } = (await res.json()) as { workspaces: Array<Record<string, unknown>> };
    const card = workspaces.find((w) => w.slug === ws.slug)!;
    expect(card).toMatchObject({
      role: "owner",
      member_count: 1,
      open_task_count: 1,
      node_count: 3,
    });
    expect(card.last_activity_at).toBe(last.updated_at);
  });
});
