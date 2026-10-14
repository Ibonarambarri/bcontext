import { describe, expect, it } from "vitest";
import type { Storage, NodeEdge } from "@/lib/storage";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import { mergeCandidateLanes, type RagHit } from "@/lib/rag";
import {
  parseRetrievalScope,
  resolveRetrievalScope,
  WORKSPACE_RAG_SCOPE,
  type RetrievalLane,
} from "./scope";

const stamp = "2026-07-18T10:00:00.000Z";
const tag = (id: string) => ({ id, workspace_id: "ws-1", name: id, normalized_name: id, slug: id, description: null, merged_into_id: null, deleted_at: null, created_at: stamp, updated_at: stamp });
function node(id: string, patch: Partial<KnowledgeNode> = {}): KnowledgeNode {
  return {
    id, workspace_id: "ws-1", parent_id: null, kind: "doc",
    slug: id, title: id, content_md: id, data: {}, tags: [], status: null,
    priority: null, assignee_id: null, due_date: null, position: 0,
    created_by: null, created_at: stamp, updated_at: stamp, ...patch,
  };
}
function storage(nodes: KnowledgeNode[], edges: NodeEdge[] = []): Storage {
  return {
    backend: "demo",
    workspace: { id: "ws-1", organization_id: "org", slug: "ws", name: "WS", description: null, github_repo: null, metadata: {}, created_at: stamp },
    listNodes: async () => nodes,
    listEdges: async () => edges,
    resolveTagIds: async () => new Map(),
    listTagRelations: async () => [],
  } as unknown as Storage;
}
const hit = (id: string, score: number): RagHit => ({
  node_id: id, title: id, kind: "doc", content: id,
  similarity: score, chunk_index: 0, block_id: null,
});

describe("RAG scope contract", () => {
  it("keeps workspace as the versioned default", () => {
    expect(parseRetrievalScope(undefined)).toEqual(WORKSPACE_RAG_SCOPE);
    expect(() => parseRetrievalScope({ schema_version: 2, type: "workspace" })).toThrow();
  });

  it("resolves tags and selection before retrieval and reasserts workspace", async () => {
    const nodes = [
      node("product", { tags: [tag("product")] }),
      node("tech", { tags: [tag("tech")] }),
      node("foreign", { workspace_id: "other", tags: [tag("product")] }),
    ];
    const tags = await resolveRetrievalScope({
      storage: storage(nodes),
      scope: { schema_version: 1, type: "tags", tags_all: ["product"] },
    });
    expect(tags.lanes[0]?.node_ids).toEqual(["product"]);
    expect(tags.metadata.size).toBe(1);

    const selection = await resolveRetrievalScope({
      storage: storage(nodes),
      scope: { schema_version: 1, type: "selection", node_ids: ["tech", "missing", "product"] },
    });
    expect(selection.lanes[0]?.node_ids).toEqual(["product", "tech"]);
  });

  it("resolves a deterministic strict neighborhood", async () => {
    const nodes = [node("a"), node("b"), node("c")];
    const result = await resolveRetrievalScope({
      storage: storage(nodes, [
        { from_node: "a", to_node: "b", relation: "references" },
        { from_node: "b", to_node: "c", relation: "references" },
      ]),
      scope: { schema_version: 1, type: "neighborhood", root_node_ids: ["a"], depth: 1 },
    });
    expect(result.lanes[0]?.node_ids).toEqual(["a", "b"]);
    expect(result.strict_node_ids).toEqual(new Set(["a", "b"]));
  });

  it("auto always adds a visible global recall lane", async () => {
    const result = await resolveRetrievalScope({
      storage: storage([node("a"), node("b")]),
      scope: { schema_version: 1, type: "auto", node_ids: ["a"] },
    });
    expect(result.lanes.map((lane) => lane.name)).toEqual(["selection", "workspace"]);
    expect(result.metadata.global_lane).toBe(true);
    expect(result.metadata.lanes.at(-1)).toMatchObject({ name: "workspace", boost: 0.65 });
  });
});

describe("candidate lane fusion", () => {
  it("normalizes independent lanes, deduplicates chunks and stays deterministic", () => {
    const scoped: RetrievalLane = { name: "selection", node_ids: ["a", "b"], boost: 1.25 };
    const global: RetrievalLane = { name: "workspace", node_ids: null, boost: 0.65 };
    const result = mergeCandidateLanes([
      { lane: scoped, hits: [hit("b", 0.001), hit("a", 0.0009)] },
      { lane: global, hits: [hit("a", 999), hit("c", 998)] },
    ]);
    expect(result.map((row) => row.node_id)).toEqual(["b", "a", "c"]);
    expect(result.filter((row) => row.node_id === "a")).toHaveLength(1);
    expect(result.find((row) => row.node_id === "a")?.candidate_lanes).toEqual(["selection", "workspace"]);
  });
});
