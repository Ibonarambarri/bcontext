import { describe, expect, it } from "vitest";
import type { Storage, NodeEdge } from "@/lib/storage";
import type { KnowledgeNode, TagRelation } from "@bcontext-dev/contract/types";
import { resolveViewQuery, ViewQueryCostError } from "./resolver";

const stamp = "2026-07-18T10:00:00.000Z";
function node(id: string, patch: Partial<KnowledgeNode> = {}): KnowledgeNode {
  return {
    id, workspace_id: "ws-1", parent_id: null, kind: "doc",
    slug: id, title: id, content_md: "", data: {}, tags: [], status: null,
    priority: null, assignee_id: null, due_date: null, position: 0,
    created_by: null, created_at: stamp, updated_at: stamp, ...patch,
  };
}
function storage(nodes: KnowledgeNode[], edges: NodeEdge[] = [], aliases: Record<string, string> = {}, tagRelations: TagRelation[] = []): Storage {
  return {
    backend: "demo",
    workspace: { id: "ws-1", organization_id: "org", slug: "ws", name: "WS", description: null, github_repo: null, metadata: {}, created_at: stamp },
    listNodes: async () => nodes,
    listEdges: async () => edges,
    resolveTagIds: async (names: string[]) => new Map(names.flatMap((name) => aliases[name] ? [[name, aliases[name]]] : [])),
    listTagRelations: async () => tagRelations,
  } as Storage;
}
const tag = (id: string) => ({ id, workspace_id: "ws-1", name: id, normalized_name: id, slug: id, description: null, merged_into_id: null, deleted_at: null, created_at: stamp, updated_at: stamp });
/** `relation: "parent"`: `from` is a CHILD of `to`. */
const childOf = (from: string, to: string, relation: TagRelation["relation"] = "parent"): TagRelation =>
  ({ id: `${from}->${to}`, workspace_id: "ws-1", from_tag_id: from, to_tag_id: to, relation, created_at: stamp });

describe("view query resolver", () => {
  it("combines kinds, status, any/all tags, dates, source and actor", async () => {
    const nodes = [
      node("match", { kind: "task", status: "todo", tags: [tag("product"), tag("launch")], data: { source: "linear" }, created_by: "actor-1", updated_at: "2026-07-18T12:00:00.000Z" }),
      node("missing-all", { kind: "task", status: "todo", tags: [tag("product")], data: { source: "linear" }, created_by: "actor-1", updated_at: "2026-07-18T12:00:00.000Z" }),
      node("wrong-source", { kind: "task", status: "todo", tags: [tag("product"), tag("launch")], data: { source: "github" }, created_by: "actor-1", updated_at: "2026-07-18T12:00:00.000Z" }),
    ];
    const result = await resolveViewQuery(storage(nodes), {
      schema_version: 1, kinds: ["task"], statuses: ["todo"], tags_any: ["product"], tags_all: ["product", "launch"],
      source: ["linear"], actor: ["actor-1"], dates: [{ field: "updated_at", from: "2026-07-18T11:00:00.000Z" }],
    });
    expect(result.node_ids).toEqual(["match"]);
    expect(result.total).toBe(1);
    expect(result.scope.type).toBe("workspace");
  });

  it("leaves archived nodes out unless the query names the status", async () => {
    const nodes = [
      node("live", { kind: "task", status: "todo" }),
      node("shelved", { kind: "task", status: "archived" }),
    ];
    expect((await resolveViewQuery(storage(nodes), { schema_version: 1 })).node_ids).toEqual(["live"]);
    expect((await resolveViewQuery(storage(nodes), { schema_version: 1, kinds: ["task"] })).node_ids).toEqual(["live"]);
    expect((await resolveViewQuery(storage(nodes), { schema_version: 1, statuses: ["archived"] })).node_ids).toEqual(["shelved"]);
    expect((await resolveViewQuery(storage(nodes), { schema_version: 1, statuses: ["todo", "archived"] })).node_ids).toEqual(["live", "shelved"]);
  });

  it("unblocked keeps actionable nodes whose blockers are all terminal, evaluated against the whole index", async () => {
    const nodes = [
      node("free", { kind: "task", status: "todo" }),
      node("waiting", { kind: "task", status: "todo" }),
      node("after-done", { kind: "task", status: "todo" }),
      node("after-archived", { kind: "task", status: "todo" }),
      node("after-missing", { kind: "task", status: "todo" }),
      node("live-blocker", { kind: "bug", status: "in_progress" }),
      node("done-blocker", { kind: "task", status: "done" }),
      node("archived-blocker", { kind: "task", status: "archived" }),
      node("decided", { kind: "decision", status: null }),
    ];
    const edge = (from: string, to: string): NodeEdge => ({ from_node: from, to_node: to, relation: "blocked_by" });
    const edges = [edge("waiting", "live-blocker"), edge("after-done", "done-blocker"), edge("after-archived", "archived-blocker"), edge("after-missing", "gone")];
    const result = await resolveViewQuery(storage(nodes, edges), { schema_version: 1, unblocked: true });
    expect(result.node_ids).toEqual(["after-archived", "after-done", "after-missing", "free", "live-blocker"]);
    expect(result.applied_filters.unblocked).toBe(true);
    // A kind filter hides the blocker from the result, never from the rule.
    const tasksOnly = await resolveViewQuery(storage(nodes, edges), { schema_version: 1, kinds: ["task"], unblocked: true });
    expect(tasksOnly.node_ids).toEqual(["after-archived", "after-done", "after-missing", "free"]);
    // Off by default, and the default is explicit in the applied filters.
    expect((await resolveViewQuery(storage(nodes, edges), { schema_version: 1, kinds: ["task"] })).applied_filters.unblocked).toBe(false);
  });

  it("resolves historical tag aliases through the first-class taxonomy", async () => {
    const tagged = node("tagged", { tags: [tag("current-tag-id")] });
    const result = await resolveViewQuery(storage([tagged], [], { "old-tag-name": "current-tag-id" }), { schema_version: 1, tags_all: ["old-tag-name"] });
    expect(result.node_ids).toEqual(["tagged"]);
  });

  it("inherits tags_any through the hierarchy: a parent tag matches descendant-tagged nodes", async () => {
    // taxonomy: product-id <- backend-id <- api-id (child -> parent edges)
    const relations = [childOf("backend-id", "product-id"), childOf("api-id", "backend-id")];
    const nodes = [
      node("direct", { tags: [tag("product-id")] }),
      node("via-child", { tags: [tag("backend-id")] }),
      node("via-grandchild", { tags: [tag("api-id")] }),
      node("unrelated", { tags: [tag("other-id")] }),
    ];
    const store = storage(nodes, [], { product: "product-id", backend: "backend-id" }, relations);
    const byParent = await resolveViewQuery(store, { schema_version: 1, tags_any: ["product"] });
    expect(byParent.node_ids).toEqual(["direct", "via-child", "via-grandchild"]);
    // No reverse inheritance: filtering by the child leaves the parent out.
    const byChild = await resolveViewQuery(store, { schema_version: 1, tags_any: ["backend"] });
    expect(byChild.node_ids).toEqual(["via-child", "via-grandchild"]);
  });

  it("inherits tags_all per requested tag and supports multi-parent tags", async () => {
    // shared-id is a child of BOTH product-id and infra-id.
    const relations = [childOf("shared-id", "product-id"), childOf("shared-id", "infra-id")];
    const nodes = [
      node("shared", { tags: [tag("shared-id")] }),
      node("only-product", { tags: [tag("product-id")] }),
    ];
    const store = storage(nodes, [], { product: "product-id", infra: "infra-id" }, relations);
    const both = await resolveViewQuery(store, { schema_version: 1, tags_all: ["infra", "product"] });
    expect(both.node_ids).toEqual(["shared"]);
    const anyParent = await resolveViewQuery(store, { schema_version: 1, tags_any: ["infra"] });
    expect(anyParent.node_ids).toEqual(["shared"]);
  });

  it("never inherits across related edges and stays cycle-safe on corrupt data", async () => {
    const relations = [
      childOf("assoc-id", "product-id", "related"),
      // Defensive: the DB forbids parent cycles, but the resolver must not hang.
      childOf("loop-a", "loop-b"),
      childOf("loop-b", "loop-a"),
    ];
    const nodes = [
      node("associated", { tags: [tag("assoc-id")] }),
      node("loop-tagged", { tags: [tag("loop-a")] }),
    ];
    const store = storage(nodes, [], { product: "product-id" }, relations);
    expect((await resolveViewQuery(store, { schema_version: 1, tags_any: ["product"] })).node_ids).toEqual([]);
    expect((await resolveViewQuery(store, { schema_version: 1, tags_any: ["loop-b"] })).node_ids).toEqual(["loop-tagged"]);
  });

  it("expands raw tag-id references without needing alias resolution", async () => {
    const relations = [childOf("backend-id", "product-id")];
    const nodes = [node("via-child", { tags: [tag("backend-id")] })];
    const result = await resolveViewQuery(storage(nodes, [], {}, relations), { schema_version: 1, tags_any: ["product-id"] });
    expect(result.node_ids).toEqual(["via-child"]);
  });

  it("reasserts workspace scope even if a storage adapter leaks a foreign row", async () => {
    const foreign = node("foreign", { workspace_id: "ws-other" });
    const result = await resolveViewQuery(storage([node("local"), foreign]), { schema_version: 1 });
    expect(result.node_ids).toEqual(["local"]);
    expect(result.scope.workspace_id).toBe("ws-1");
  });

  it("traverses deterministically by direction, depth and edge type and deduplicates cycles", async () => {
    const nodes = [node("a"), node("b"), node("c"), node("d")];
    const edges = [
      { from_node: "a", to_node: "b", relation: "references" },
      { from_node: "b", to_node: "c", relation: "references" },
      { from_node: "c", to_node: "a", relation: "references" },
      { from_node: "d", to_node: "a", relation: "blocked_by" },
    ];
    const result = await resolveViewQuery(storage(nodes, edges), {
      schema_version: 1, root_node_ids: ["a"], traversal: { edge_types: ["references"], direction: "outgoing", depth: 2, max_nodes: 10, max_edges: 10 },
    });
    expect(result.node_ids).toEqual(["a", "b", "c"]);
    expect(result.total).toBe(3);
    expect(result.scope.traversed_edges).toBe(2);
  });

  it("resolves a semantic view root and its subtree", async () => {
    const root = node("root", { kind: "adr" });
    const child = node("child", { parent_id: root.id });
    const grandchild = node("grandchild", { parent_id: child.id });
    const outside = node("outside");
    const result = await resolveViewQuery(storage([root, child, grandchild, outside]), { schema_version: 1, root_node_ids: [root.id] });
    expect(result.node_ids).toEqual(["child", "grandchild", "root"]);
  });

  it("truncates at explicit traversal limits and rejects excessive estimated cost", async () => {
    const nodes = [node("a"), node("b"), node("c")];
    const edges = [{ from_node: "a", to_node: "b", relation: "references" }, { from_node: "a", to_node: "c", relation: "references" }];
    const limited = await resolveViewQuery(storage(nodes, edges), { schema_version: 1, root_node_ids: ["a"], traversal: { depth: 1, max_nodes: 2, max_edges: 10 } });
    expect(limited.node_ids).toHaveLength(2);
    expect(limited.scope.truncated).toBe(true);
    await expect(resolveViewQuery(storage(nodes), { schema_version: 1, root_node_ids: Array.from({ length: 50 }, (_, i) => `r${i}`), traversal: { depth: 3, max_edges: 2_000 } })).rejects.toBeInstanceOf(ViewQueryCostError);
  });

  it("applies max_nodes when a semantic root expands to a larger subtree", async () => {
    const root = node("root", { kind: "doc" });
    const nodes = [root, node("a", { parent_id: root.id }), node("b", { parent_id: root.id })];
    const result = await resolveViewQuery(storage(nodes), { schema_version: 1, root_node_ids: [root.id], traversal: { depth: 1, max_nodes: 2, max_edges: 5 } });
    expect(result.node_ids).toHaveLength(2);
    expect(result.node_ids).toContain(root.id);
    expect(result.scope.truncated).toBe(true);
  });
});
