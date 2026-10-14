import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./import-md";
import { exportNodeAsMarkdown } from "./export-md";
import type { KnowledgeNode, WorkspaceTag } from "@bcontext-dev/contract/types";

const ISO = "2026-07-18T00:00:00.000Z";

function tag(id: string, name: string, slug: string): WorkspaceTag {
  return {
    id,
    workspace_id: "ws-1",
    name,
    normalized_name: name.toLowerCase(),
    slug,
    description: null,
    merged_into_id: null,
    deleted_at: null,
    created_at: ISO,
    updated_at: ISO,
  };
}

describe("folderless first-class tag export", () => {
  it("exports every assigned tag without category or tree fields", () => {
    const node: KnowledgeNode = {
      id: "node-1",
      workspace_id: "ws-1",
      parent_id: null,
      kind: "decision",
      slug: "runtime-choice",
      title: "Runtime choice",
      content_md: "## Decision\nUse the shared runtime.",
      data: {},
      tags: [
        tag("tag-product", "Product", "product"),
        tag("tag-ai", "AI", "ai"),
        tag("tag-tech", "Tech", "tech"),
      ],
      status: null,
      priority: null,
      assignee_id: null,
      due_date: null,
      position: 0,
      created_by: null,
      created_at: ISO,
      updated_at: ISO,
    };

    const exported = exportNodeAsMarkdown(node);
    expect(exported.body).toContain("bcontext_schema: 2");
    expect(exported.body).toContain("kind: decision");
    expect(exported.body).not.toContain("category:");
    expect(exported.body).not.toContain("parent_id:");
    expect(exported.body).toContain("tags: [product, ai, tech]");

    const imported = parseMarkdown(exported.body, exported.filename);
    expect(imported.kind).toBe("decision");
    expect(imported.tags).toEqual(["product", "ai", "tech"]);
  });
});
