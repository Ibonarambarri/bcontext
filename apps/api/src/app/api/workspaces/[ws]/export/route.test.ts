import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { GET } from "./route";

describe("folderless workspace export", () => {
  it("writes a flat schema-v2 archive with tag classification", async () => {
    const slug = `export-flat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    createWorkspace({ name: "Flat export", slug });
    const storage = resolveDemoStorage(slug)!;
    const product = (await storage.listTags()).find((tag) => tag.normalized_name === "product")!;
    const parent = await storage.createNode({
      title: "Project",
      kind: "doc",
      parent_id: null,
      tag_ids: [product.id],
    });
    await storage.createNode({ title: "Decision", kind: "decision", parent_id: parent.id });

    const response = await GET(
      new Request(`http://localhost/api/workspaces/${slug}/export`, {
        headers: { origin: "http://localhost", host: "localhost" },
      }),
      { params: Promise.resolve({ ws: slug }) },
    );
    expect(response.status).toBe(200);
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(["decision.md", "index.md", "project.md"]);
    const project = await zip.file("project.md")!.async("string");
    expect(project).toContain("bcontext_schema: 2");
    expect(project).toContain("tags: [product]");
    expect(project).not.toContain("category:");
    expect(project).not.toContain("parent_id:");
    expect(await zip.file("index.md")!.async("string")).toContain("layout: flat");
  });
});
