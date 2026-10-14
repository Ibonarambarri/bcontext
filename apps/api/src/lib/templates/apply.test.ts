import { describe, expect, it } from "vitest";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { applyTemplate } from "./apply";
import type { WorkspaceTemplate } from "@bcontext-dev/contract/templates/workspaces";
import { listTemplates } from "@bcontext-dev/contract/templates/workspaces";

describe("template taxonomy assignments", () => {
  it("ships only semantic nodes and first-class tag classification", () => {
    for (const template of listTemplates()) {
      expect(template.nodes.every((node) => node.kind !== ("folder" as never))).toBe(true);
      expect(template.nodes.every((node) => !("category" in node))).toBe(true);
    }
  });

  it("keeps kind semantics while assigning several reusable tags", async () => {
    const slug = `template-tags-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    createWorkspace({ name: "Template tags", slug });
    const storage = resolveDemoStorage(slug);
    if (!storage) throw new Error("demo storage missing");
    const product = (await storage.listTags()).find(
      (tag) => tag.normalized_name === "product",
    )!;
    await storage.updateTag(product.id, { name: "Product Area" });
    const template: WorkspaceTemplate = {
      id: "taxonomy-test",
      name: "Taxonomy test",
      description: "test",
      nodes: [
        {
          key: "decision",
          parent: null,
          title: "Agent runtime",
          kind: "decision",
          tags: ["Product", "AI"],
        },
      ],
    };

    const result = await applyTemplate(storage, template);
    const node = await storage.getNode(result.created[0]!.id);

    expect(node?.kind).toBe("decision");
    expect(node?.tags.map((item) => item.normalized_name).sort()).toEqual([
      "ai",
      "product area",
    ]);
    expect(node?.tags.find((item) => item.normalized_name === "product area")?.id)
      .toBe(product.id);
  });
});
