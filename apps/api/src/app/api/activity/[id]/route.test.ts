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

describe("GET /api/activity/[id]", () => {
  it("returns the full entry (snapshots included) for a slim feed row", async () => {
    const workspace = createWorkspace({ name: "Activity detail", slug: `activity-detail-${Date.now()}-${Math.random()}` });
    const storage = resolveDemoStorage(workspace.slug)!;
    const node = await storage.createNode({ title: "Doc", kind: "doc", parent_id: null, content_md: "# Heading\n\nBody" });
    const entry = record(workspace.slug, "create", node.id, node.title, node.kind, {
      actorKind: "human",
      payload: changePayload({ after: node, via: "web" }),
    });

    const response = await GET(
      request(`/api/activity/${entry.id}?workspace=${encodeURIComponent(workspace.slug)}`),
      { params: Promise.resolve({ id: entry.id }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { change: { id: string; after: { content_md: string } | null } };
    expect(body.change.id).toBe(entry.id);
    expect(body.change.after?.content_md).toContain("Heading");
  });

  it("404s for unknown entries and never crosses workspaces", async () => {
    const a = createWorkspace({ name: "Detail A", slug: `detail-a-${Date.now()}-${Math.random()}` });
    const b = createWorkspace({ name: "Detail B", slug: `detail-b-${Date.now()}-${Math.random()}` });
    const storageB = resolveDemoStorage(b.slug)!;
    const nodeB = await storageB.createNode({ title: "Foreign", kind: "doc", parent_id: null });
    const entryB = record(b.slug, "create", nodeB.id, nodeB.title, nodeB.kind, {
      actorKind: "human",
      payload: changePayload({ after: nodeB, via: "web" }),
    });

    const missing = await GET(
      request(`/api/activity/does-not-exist?workspace=${encodeURIComponent(a.slug)}`),
      { params: Promise.resolve({ id: "does-not-exist" }) },
    );
    expect(missing.status).toBe(404);

    const crossTenant = await GET(
      request(`/api/activity/${entryB.id}?workspace=${encodeURIComponent(a.slug)}`),
      { params: Promise.resolve({ id: entryB.id }) },
    );
    expect(crossTenant.status).toBe(404);
  });
});
