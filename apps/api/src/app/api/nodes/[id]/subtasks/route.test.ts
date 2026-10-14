import { describe, expect, it } from "vitest";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { subtasksFromDrafts } from "@bcontext-dev/contract/subtasks";
import { GET, POST } from "./route";
import { POST as CREATE } from "../../route";

const headers = { origin: "http://localhost", host: "localhost", "Content-Type": "application/json" };

function get(path: string) {
  return new Request(`http://localhost${path}`, { headers });
}
function post(path: string, payload: unknown) {
  return new Request(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(payload) });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function seed() {
  const workspace = createWorkspace({ name: "Subtasks REST", slug: `subtasks-rest-${Date.now()}-${Math.random().toString(36).slice(2)}` });
  const storage = resolveDemoStorage(workspace.slug)!;
  const node = await storage.createNode({
    title: "Task",
    kind: "task",
    parent_id: null,
    status: "todo",
    data: { subtasks: subtasksFromDrafts([{ title: "A", summary: "first", content_md: "body A" }, { title: "B", summary: "", content_md: "" }]) },
  });
  return { workspace, storage, node };
}

describe("/api/nodes/:id/subtasks", () => {
  it("GET lists cards and progress", async () => {
    const { workspace, node } = await seed();
    const response = await GET(get(`/api/nodes/${node.id}/subtasks?workspace=${workspace.slug}`), params(node.id));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { progress: unknown; subtasks: Array<Record<string, unknown>> };
    expect(body.progress).toEqual({ done: 0, total: 2 });
    expect(body.subtasks[0]).toMatchObject({ title: "A", summary: "first", done: false });
    expect(body.subtasks[0]).not.toHaveProperty("content_md");
  });

  it("POST toggles one step, guarded by if_updated_at", async () => {
    const { workspace, storage, node } = await seed();
    const id = (node.data.subtasks as Array<{ id: string }>)[0]!.id;
    // updated_at has millisecond resolution: a write in the same tick as the
    // seed would leave the "stale" timestamp equal to the current one.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const ok = await POST(post(`/api/nodes/${node.id}/subtasks`, { workspace: workspace.slug, op: "toggle", id, if_updated_at: node.updated_at }), params(node.id));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { changed: boolean; subtask: { done: boolean }; progress: { done: number }; node: { updated_at: string } };
    expect(body.changed).toBe(true);
    expect(body.subtask.done).toBe(true);
    expect(body.progress.done).toBe(1);

    const stale = await POST(post(`/api/nodes/${node.id}/subtasks`, { workspace: workspace.slug, op: "toggle", id, if_updated_at: node.updated_at }), params(node.id));
    expect(stale.status).toBe(409);
    expect((await storage.getNode(node.id))!.updated_at).toBe(body.node.updated_at);
  });

  it("POST validates the op shape and the node kind", async () => {
    const { workspace, storage, node } = await seed();
    const bad = await POST(post(`/api/nodes/${node.id}/subtasks`, { workspace: workspace.slug, op: "add" }), params(node.id));
    expect(bad.status).toBe(400);
    const unknown = await POST(post(`/api/nodes/${node.id}/subtasks`, { workspace: workspace.slug, op: "delete", id: "nope" }), params(node.id));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()) as { error: string }).toMatchObject({ error: "invalid" });
    const missing = await POST(post(`/api/nodes/does-not-exist/subtasks`, { workspace: workspace.slug, op: "delete", id: "x" }), params("does-not-exist"));
    expect(missing.status).toBe(404);
    const doc = await storage.createNode({ title: "Doc", kind: "doc", parent_id: null });
    const wrongKind = await POST(post(`/api/nodes/${doc.id}/subtasks`, { workspace: workspace.slug, op: "add", title: "x" }), params(doc.id));
    expect(wrongKind.status).toBe(400);
    expect((await wrongKind.json()) as { error: string }).toMatchObject({ error: "wrong_kind" });
  });

  it("POST /api/nodes accepts subtasks on create for tasks only", async () => {
    const { workspace } = await seed();
    const created = await CREATE(post(`/api/nodes`, {
      workspace: workspace.slug, kind: "task", title: "With steps", parent_id: null,
      subtasks: [{ title: "One", summary: "s1" }, { title: "Two" }],
    }));
    expect(created.status).toBe(201);
    const body = (await created.json()) as { node: { data: { subtasks: Array<{ id: string; title: string; summary: string }> } } };
    expect(body.node.data.subtasks.map((s) => s.title)).toEqual(["One", "Two"]);
    expect(body.node.data.subtasks[0]!.id).toMatch(/^s[a-z0-9]{6}$/);

    const refused = await CREATE(post(`/api/nodes`, { workspace: workspace.slug, kind: "doc", title: "Doc", parent_id: null, subtasks: [{ title: "x" }] }));
    expect(refused.status).toBe(400);
    expect((await refused.json()) as { error: string }).toMatchObject({ error: "subtasks_wrong_kind" });
  });
});
