import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { POST } from "./route";

async function upload(slug: string, file: File, parentId?: string) {
  const form = new FormData();
  form.set("file", file);
  if (parentId) form.set("parent_id", parentId);
  return POST(
    new Request(`http://localhost/api/workspaces/${slug}/import`, {
      method: "POST",
      headers: { origin: "http://localhost", host: "localhost" },
      body: form,
    }),
    { params: Promise.resolve({ ws: slug }) },
  );
}

describe("folderless workspace import", () => {
  it("turns category frontmatter into a tag without writing category", async () => {
    const slug = `import-tags-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    createWorkspace({ name: "Import tags", slug });
    const response = await upload(slug, new File([
      "---\ntitle: Imported brief\nkind: doc\ncategory: product\ntags: [Research, AI]\n---\n\nBody",
    ], "brief.md", { type: "text/markdown" }));

    expect(response.status).toBe(201);
    const body = await response.json() as {
      nodes: Array<{ id: string; tags: Array<{ normalized_name: string }> }>;
    };
    expect(body.nodes[0]?.tags.map((tag) => tag.normalized_name).sort()).toEqual([
      "ai",
      "product",
      "research",
    ]);
    const storage = resolveDemoStorage(slug)!;
    expect((await storage.listNodes({ tagSlugs: ["research"] }))[0]?.id).toBe(body.nodes[0]?.id);
  });

  it("accumulates ZIP directory segments as tags and creates no folder nodes", async () => {
    const slug = `import-zip-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    createWorkspace({ name: "Import ZIP", slug });
    const zip = new JSZip();
    zip.file("Clients/Acme/Research/brief.md", "---\nkind: folder\ntags: [Q4]\n---\n\nBody");
    const bytes = await zip.generateAsync({ type: "arraybuffer" });
    const response = await upload(slug, new File([bytes], "notion-export.zip", { type: "application/zip" }));

    expect(response.status).toBe(201);
    const storage = resolveDemoStorage(slug)!;
    const nodes = await storage.listNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.kind).toBe("doc");
    expect(nodes[0]?.parent_id).toBeNull();
    expect(nodes[0]?.tags.map((tag) => tag.normalized_name).sort()).toEqual([
      "acme",
      "clients",
      "q4",
      "research",
    ]);
  });
});
