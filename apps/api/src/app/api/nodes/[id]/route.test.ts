import { describe, expect, it } from "vitest";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { PATCH } from "./route";
import { POST } from "../route";

const headers = { "content-type": "application/json", origin: "http://localhost", host: "localhost" };

describe("node PATCH optimistic concurrency", () => {
  it("updates and clears a due date", async () => {
    const workspace = createWorkspace({ name: "Due dates", slug: `due-dates-${Date.now()}-${Math.random()}` });
    const storage = resolveDemoStorage(workspace.slug)!;
    const task = await storage.createNode({ title: "Task", kind: "task", parent_id: null });
    const set = new Request(`http://localhost/api/nodes/${task.id}`, {
      method: "PATCH", headers, body: JSON.stringify({ workspace: workspace.slug, due_date: "2026-07-20T12:00:00.000Z", if_updated_at: task.updated_at }),
    });
    expect((await PATCH(set, { params: Promise.resolve({ id: task.id }) })).status).toBe(200);
    const dated = (await storage.getNode(task.id))!;
    expect(dated.due_date).toBe("2026-07-20T12:00:00.000Z");
    const clear = new Request(`http://localhost/api/nodes/${task.id}`, {
      method: "PATCH", headers, body: JSON.stringify({ workspace: workspace.slug, due_date: null, if_updated_at: dated.updated_at }),
    });
    expect((await PATCH(clear, { params: Promise.resolve({ id: task.id }) })).status).toBe(200);
    expect((await storage.getNode(task.id))?.due_date).toBeNull();
  });

  it("rejects a stale board move with 409 and preserves the concurrent value", async () => {
    const workspace = createWorkspace({ name: "Board conflict", slug: `board-conflict-${Date.now()}-${Math.random()}` });
    const storage = resolveDemoStorage(workspace.slug)!;
    const task = await storage.createNode({ title: "Task", kind: "task", parent_id: null, status: "todo" });
    const concurrent = await storage.updateNode(task.id, { status: "in_progress" });

    const request = new Request(`http://localhost/api/nodes/${task.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        workspace: workspace.slug,
        status: "done",
        if_updated_at: "2000-01-01T00:00:00.000Z",
      }),
    });
    const response = await PATCH(request, { params: Promise.resolve({ id: task.id }) });
    expect(response.status).toBe(409);
    expect((await response.json()) as { current_updated_at: string }).toMatchObject({ current_updated_at: concurrent!.updated_at });
    expect((await storage.getNode(task.id))?.status).toBe("in_progress");
  });

  it("edits parent and order as semantic hierarchy properties", async () => {
    const workspace = createWorkspace({ name: "Node organization", slug: `node-organization-${Date.now()}-${Math.random()}` });
    const storage = resolveDemoStorage(workspace.slug)!;
    const parent = await storage.createNode({ title: "Project", kind: "doc", parent_id: null });
    const doc = await storage.createNode({ title: "Doc", kind: "doc", parent_id: null });
    const request = new Request(`http://localhost/api/nodes/${doc.id}`, { method: "PATCH", headers, body: JSON.stringify({ workspace: workspace.slug, parent_id: parent.id, position: 42, if_updated_at: doc.updated_at }) });
    expect((await PATCH(request, { params: Promise.resolve({ id: doc.id }) })).status).toBe(200);
    expect(await storage.getNode(doc.id)).toMatchObject({ parent_id: parent.id, position: 42 });
  });

  it("rejects retired folder and category writes at the REST schema", async () => {
    const workspace = createWorkspace({ name: "Folderless REST", slug: `folderless-rest-${Date.now()}-${Math.random()}` });
    const folderRequest = new Request("http://localhost/api/nodes", {
      method: "POST",
      headers,
      body: JSON.stringify({ workspace: workspace.slug, title: "Folder", kind: "folder", parent_id: null }),
    });
    expect((await POST(folderRequest)).status).toBe(400);

    const categoryRequest = new Request("http://localhost/api/nodes", {
      method: "POST",
      headers,
      body: JSON.stringify({ workspace: workspace.slug, title: "Doc", kind: "doc", parent_id: null, category: "product" }),
    });
    expect((await POST(categoryRequest)).status).toBe(400);
  });
});
