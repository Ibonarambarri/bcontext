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

describe("GET /api/activity/facets", () => {
  it("returns distinct sorted sources without shipping feed entries", async () => {
    const workspace = createWorkspace({ name: "Facets", slug: `facets-${Date.now()}-${Math.random()}` });
    const storage = resolveDemoStorage(workspace.slug)!;
    const node = await storage.createNode({ title: "Doc", kind: "doc", parent_id: null });
    record(workspace.slug, "create", node.id, node.title, node.kind, {
      actorKind: "agent",
      payload: changePayload({ after: node, via: "mcp", source: "github" }),
    });
    record(workspace.slug, "update", node.id, node.title, node.kind, {
      actorKind: "human",
      payload: changePayload({ before: node, after: node, via: "web", source: "web" }),
    });
    record(workspace.slug, "update", node.id, node.title, node.kind, {
      actorKind: "agent",
      payload: changePayload({ before: node, after: node, via: "mcp", source: "github" }),
    });

    const response = await GET(request(`/api/activity/facets?workspace=${encodeURIComponent(workspace.slug)}`));
    expect(response.status).toBe(200);
    const body = await response.json() as { facets: { sources: string[] } } & Record<string, unknown>;
    expect(body.facets.sources).toEqual(["github", "web"]);
    expect(body).not.toHaveProperty("changes");
  });

  it("requires a workspace", async () => {
    const response = await GET(request("/api/activity/facets"));
    expect(response.status).toBe(400);
  });
});
