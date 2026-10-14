import { describe, expect, it } from "vitest";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { GET } from "./route";

function get(path: string, slug: string) {
  return GET(
    new Request(`http://localhost${path}`, { headers: { origin: "http://localhost", host: "localhost" } }),
    { params: Promise.resolve({ slug }) },
  );
}

describe("GET /api/nodes/by-slug/:slug", () => {
  it("resolves the current slug, and a slug the node had before a rename", async () => {
    const workspace = createWorkspace({ name: "By slug", slug: `by-slug-${Date.now()}-${Math.random()}` });
    const storage = resolveDemoStorage(workspace.slug)!;
    const node = await storage.createNode({ title: "Old Title", kind: "doc", parent_id: null, content_md: "body" });

    const current = await get(`/api/nodes/by-slug/${node.slug}?workspace=${workspace.slug}`, node.slug);
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({ id: node.id, slug: node.slug });

    const renamed = (await storage.updateNode(node.id, { title: "New Title" }))!;
    expect(renamed.slug).not.toBe(node.slug);
    const historical = await get(`/api/nodes/by-slug/${node.slug}?workspace=${workspace.slug}`, node.slug);
    expect(historical.status).toBe(200);
    // The answer carries the slug the node has now, so a caller can canonicalise.
    expect(await historical.json()).toEqual({ id: node.id, slug: renamed.slug });
  });

  it("is a 404 for a slug nobody has, and for a workspace that does not resolve", async () => {
    const workspace = createWorkspace({ name: "By slug miss", slug: `by-slug-miss-${Date.now()}-${Math.random()}` });
    const miss = await get(`/api/nodes/by-slug/nothing-here?workspace=${workspace.slug}`, "nothing-here");
    expect(miss.status).toBe(404);
    const noWorkspace = await get(`/api/nodes/by-slug/anything?workspace=no-such-workspace-${Date.now()}`, "anything");
    expect(noWorkspace.status).toBe(404);
  });
});
