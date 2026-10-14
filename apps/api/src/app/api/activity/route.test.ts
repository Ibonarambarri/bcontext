import { describe, expect, it } from "vitest";
import { record } from "@/lib/activity";
import { changePayload } from "@bcontext-dev/contract/changes";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { GET } from "./route";

function request(path: string) {
  return new Request(`http://localhost${path}`, {
    headers: { origin: "http://localhost", host: "localhost" },
  });
}

describe("GET /api/activity", () => {
  it("serves the shared filtered feed without crossing workspace buffers", async () => {
    const a = createWorkspace({ name: "Activity A", slug: `activity-a-${Date.now()}-${Math.random()}` });
    const b = createWorkspace({ name: "Activity B", slug: `activity-b-${Date.now()}-${Math.random()}` });
    const storageA = resolveDemoStorage(a.slug)!;
    const storageB = resolveDemoStorage(b.slug)!;
    const nodeA = await storageA.createNode({ title: "Agent task", kind: "task", parent_id: null, status: "todo" });
    const nodeB = await storageB.createNode({ title: "Foreign", kind: "task", parent_id: null, status: "todo" });
    record(a.slug, "create", nodeA.id, nodeA.title, nodeA.kind, { actorKind: "agent", principalId: "agent-a", payload: changePayload({ after: nodeA, via: "mcp" }) });
    record(b.slug, "create", nodeB.id, nodeB.title, nodeB.kind, { actorKind: "agent", principalId: "agent-b", payload: changePayload({ after: nodeB, via: "mcp" }) });

    const response = await GET(request(`/api/activity?workspace=${encodeURIComponent(a.slug)}&actor=agent&node_kind=task&node=${nodeA.id}`));
    expect(response.status).toBe(200);
    const body = await response.json() as { changes: Array<{ node_id: string; actor_principal_id: string }>; permissions: { read: boolean; revert: boolean }; retention: { operational_days: number } };
    expect(body.changes).toEqual([expect.objectContaining({ node_id: nodeA.id, actor_principal_id: "agent-a" })]);
    expect(body.changes.some((entry) => entry.node_id === nodeB.id)).toBe(false);
    expect(body.permissions).toEqual(expect.objectContaining({ read: true, revert: false }));
    expect(body.retention.operational_days).toBe(180);
  });

  it("strips before/after snapshots from list-preset pages while keeping row metadata", async () => {
    const workspace = createWorkspace({ name: "Activity slim", slug: `activity-slim-${Date.now()}-${Math.random()}` });
    const storage = resolveDemoStorage(workspace.slug)!;
    const node = await storage.createNode({ title: "Doc", kind: "doc", parent_id: null, content_md: "# Long body\n\nlots of markdown" });
    record(workspace.slug, "create", node.id, node.title, node.kind, { actorKind: "human", payload: changePayload({ after: node, via: "web" }) });

    const slim = await GET(request(`/api/activity?workspace=${encodeURIComponent(workspace.slug)}&fields=list`));
    expect(slim.status).toBe(200);
    const slimBody = await slim.json() as { changes: Array<{ before: unknown; after: unknown; snapshot_state: string; node_title: string | null; source: string | null }> };
    expect(slimBody.changes[0]).toMatchObject({ before: null, after: null, snapshot_state: "available", node_title: "Doc" });

    const full = await GET(request(`/api/activity?workspace=${encodeURIComponent(workspace.slug)}`));
    const fullBody = await full.json() as { changes: Array<{ after: { content_md: string } | null }> };
    expect(fullBody.changes[0]?.after?.content_md).toContain("Long body");

    const invalid = await GET(request(`/api/activity?workspace=${encodeURIComponent(workspace.slug)}&fields=everything`));
    expect(invalid.status).toBe(400);
  });

  it("rejects malformed pagination cursors explicitly", async () => {
    const workspace = createWorkspace({ name: "Activity cursor", slug: `activity-cursor-${Date.now()}-${Math.random()}` });
    const response = await GET(request(`/api/activity?workspace=${encodeURIComponent(workspace.slug)}&cursor=not-valid`));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_cursor" });
  });
});
