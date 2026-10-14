import { describe, expect, it } from "vitest";
import { normalizeViewPresentation, normalizeViewQuery } from "@bcontext-dev/contract/views/schema";
import type { KnowledgeNode, WorkspaceTag } from "@bcontext-dev/contract/types";
import type { Storage } from "@/lib/storage";
import type { ResolvedViewQuery, SavedView } from "@bcontext-dev/contract/views/types";
import { buildGraphViewSnapshot, graphOptions, filterCenterTagTokens } from "./view-snapshot";

function view(): Pick<SavedView, "query" | "presentation"> {
  return {
    query: normalizeViewQuery({ schema_version: 1 }),
    presentation: normalizeViewPresentation({
      schema_version: 1,
      renderer: "graph",
      clustering: { graph: { by: "parent" } },
      layout: { graph: { positions: { a: { x: 0.2, y: 0.7 } } } },
    }),
  };
}

describe("graph view presentation", () => {
  it("reads persisted coordinates and ignores legacy automatic clustering", () => {
    const options = graphOptions(view());
    expect(options.clusterBy).toBeUndefined();
    expect(options.positions).toEqual({ a: { x: 0.2, y: 0.7 } });
  });

  it("does not revive legacy first-tag clustering", () => {
    const legacy = view();
    legacy.presentation = normalizeViewPresentation({ ...legacy.presentation, clustering: { graph: { by: "tag" } } });
    expect(graphOptions(legacy).clusterBy).toBeUndefined();
  });

  it("uses exactly two batch reads and rejects foreign-workspace resources", async () => {
    const calls: string[] = [];
    const storage = {
      workspace: { id: "ws", organization_id: "org", slug: "ws", name: "WS", description: null, github_repo: null, metadata: {}, created_at: "now" },
      listNodeSummaries: async () => { calls.push("nodes"); return [summary("own", "ws"), summary("foreign", "other")]; },
      listEdges: async () => { calls.push("edges"); return []; },
    } as unknown as Storage;
    const configured = view();
    configured.presentation = normalizeViewPresentation({ ...configured.presentation, clustering: { graph: { by: "none" } } });
    const saved = {
      ...configured, id: "view", workspace_id: "ws", system_key: "graph", name: "Graph", slug: "graph", description: null,
      kind: "system", visibility: "workspace", owner_id: null, owner_token_id: null, schema_version: 1, version: 1, created_at: "now", updated_at: "now",
    } as SavedView;
    const result = {
      node_ids: ["own", "foreign"], total: 2, applied_filters: saved.query,
      scope: { type: "workspace", workspace_id: "ws", root_node_ids: [], traversed_edges: 0, estimated_cost: 1, truncated: false, limits: {} },
    } satisfies ResolvedViewQuery;
    const snapshot = await buildGraphViewSnapshot(storage, saved, result);
    expect(calls).toEqual(["nodes", "edges"]);
    // Query mode always gains the fixed workspace hub ahead of resolved content.
    expect(snapshot.nodes.filter((item) => item.resource_type === "node").map((item) => item.id)).toEqual(["workspace:ws", "own"]);
    expect(snapshot.nodes.filter((item) => item.resource_type === "tag")).toHaveLength(1);
    expect(snapshot.hub_node_id).toBe("workspace:ws");
  });

  it("resolves a current single-tag filter from node summaries without another taxonomy read", async () => {
    const calls: string[] = [];
    const product = assignedTag("product-id", "Product");
    const storage = {
      workspace: { id: "ws", organization_id: "org", slug: "ws", name: "WS", description: null, github_repo: null, metadata: {}, created_at: "now" },
      listNodeSummaries: async () => { calls.push("nodes"); return [summary("one", "ws", [product])]; },
      listEdges: async () => { calls.push("edges"); return []; },
      resolveTagIds: async () => { throw new Error("current tag should not need alias resolution"); },
    } as unknown as Storage;
    const configured = view();
    configured.query = normalizeViewQuery({ schema_version: 1, tags_any: ["product"] });
    const saved = {
      ...configured, id: "view", workspace_id: "ws", system_key: null, name: "Product graph", slug: "product-graph", description: null,
      kind: "custom", visibility: "workspace", owner_id: null, owner_token_id: null, schema_version: 1, version: 1, created_at: "now", updated_at: "now",
    } as SavedView;
    const result = {
      node_ids: ["one"], total: 1, applied_filters: saved.query,
      scope: { type: "workspace", workspace_id: "ws", root_node_ids: [], traversed_edges: 0, estimated_cost: 1, truncated: false, limits: {} },
    } satisfies ResolvedViewQuery;

    const snapshot = await buildGraphViewSnapshot(storage, saved, result);

    expect(calls).toEqual(["nodes", "edges"]);
    // Filter semantics: the filter tag IS the center — pinned at the canvas
    // center, marked filter-center, workspace hub omitted entirely.
    expect(snapshot.nodes.map((item) => item.id).sort()).toEqual(["one", "tag:product-id"]);
    expect(snapshot.hub_node_id).toBe("tag:product-id");
    const center = snapshot.nodes.find((item) => item.id === "tag:product-id")!;
    expect(center.role).toBe("filter-center");
    expect({ x: center.x, y: center.y }).toEqual({ x: 0.5, y: 0.5 });
    expect(snapshot.pinned_positions["tag:product-id"]).toEqual({ x: 0.5, y: 0.5 });
    expect(snapshot.edges.map((edge) => [edge.layer, edge.from, edge.to])).toEqual([
      ["taxonomy", "tag:product-id", "one"],
    ]);
  });

  it("centers the guaranteed filter tag and prunes co-tags outside the filter chain", async () => {
    const calls: string[] = [];
    const product = assignedTag("product-id", "Product");
    const tech = assignedTag("tech-id", "Tech");
    const storage = {
      workspace: { id: "ws", organization_id: "org", slug: "ws", name: "WS", description: null, github_repo: null, metadata: {}, created_at: "now" },
      listNodeSummaries: async () => {
        calls.push("nodes");
        return [summary("one", "ws", [product, tech]), summary("two", "ws", [product])];
      },
      listEdges: async () => { calls.push("edges"); return []; },
      resolveTagIds: async () => { calls.push("tags"); return new Map([["legacy-product", product.id]]); },
    } as unknown as Storage;
    const configured = view();
    configured.query = normalizeViewQuery({ schema_version: 1, tags_all: ["legacy-product"] });
    const saved = {
      ...configured, id: "view", workspace_id: "ws", system_key: null, name: "Product graph", slug: "product-graph", description: null,
      kind: "custom", visibility: "workspace", owner_id: null, owner_token_id: null, schema_version: 1, version: 1, created_at: "now", updated_at: "now",
    } as SavedView;
    const result = {
      node_ids: ["one", "two"], total: 2, applied_filters: saved.query,
      scope: { type: "workspace", workspace_id: "ws", root_node_ids: [], traversed_edges: 0, estimated_cost: 1, truncated: false, limits: {} },
    } satisfies ResolvedViewQuery;

    const snapshot = await buildGraphViewSnapshot(storage, saved, result);

    expect(calls).toEqual(["nodes", "edges", "tags"]);
    // Historical alias resolves to the current tag, which becomes the
    // center. The unrelated co-tag is NOT rendered: a filtered view only
    // shows the filter chain, never the surrounding taxonomy — co-tag
    // memberships drop with their hub, but the nodes keep their tag names.
    expect(snapshot.nodes.filter((item) => item.resource_type === "tag").map((item) => [item.id, item.role ?? null]))
      .toEqual([["tag:product-id", "filter-center"]]);
    expect(snapshot.hub_node_id).toBe("tag:product-id");
    expect(snapshot.edges.filter((edge) => edge.layer === "taxonomy").map((edge) => [edge.from, edge.to]))
      .toEqual([["tag:product-id", "one"], ["tag:product-id", "two"]]);
    expect(snapshot.nodes.filter((item) => item.resource_type === "node").map((item) => item.tags))
      .toEqual([["product", "tech"], ["product"]]);
  });

  it("keeps the filter's complete subtree — used and unused descendants — when the filter matched through the hierarchy", async () => {
    const product = assignedTag("product-id", "Product");
    const graphTag = assignedTag("graph-id", "Graph");
    const icebox = assignedTag("icebox-id", "Icebox");
    const tech = assignedTag("tech-id", "Tech");
    const calls: string[] = [];
    const storage = {
      workspace: { id: "ws", organization_id: "org", slug: "ws", name: "WS", description: null, github_repo: null, metadata: {}, created_at: "now" },
      // "one" matched via the descendant Graph tag and drags in a co-tag from
      // another family (Tech); "two" carries the filter directly. Nobody
      // carries Icebox — its descriptor only exists in the taxonomy read.
      listNodeSummaries: async () => [summary("one", "ws", [graphTag, tech]), summary("two", "ws", [product])],
      listEdges: async () => [],
      listTags: async () => { calls.push("listTags"); return [product, graphTag, icebox, tech]; },
      listTagRelations: async () => [
        { id: "r1", workspace_id: "ws", from_tag_id: "graph-id", to_tag_id: "product-id", relation: "parent", created_at: "now" },
        { id: "r2", workspace_id: "ws", from_tag_id: "icebox-id", to_tag_id: "product-id", relation: "parent", created_at: "now" },
      ],
    } as unknown as Storage;
    const configured = view();
    configured.query = normalizeViewQuery({ schema_version: 1, tags_any: ["product"] });
    const saved = {
      ...configured, id: "view", workspace_id: "ws", system_key: null, name: "Product graph", slug: "product-graph", description: null,
      kind: "custom", visibility: "workspace", owner_id: null, owner_token_id: null, schema_version: 1, version: 1, created_at: "now", updated_at: "now",
    } as SavedView;
    const result = {
      node_ids: ["one", "two"], total: 2, applied_filters: saved.query,
      scope: { type: "workspace", workspace_id: "ws", root_node_ids: [], traversed_edges: 0, estimated_cost: 1, truncated: false, limits: {} },
    } satisfies ResolvedViewQuery;

    const snapshot = await buildGraphViewSnapshot(storage, saved, result);

    // Chain = filter + its COMPLETE subtree: Product centers, Graph stays as
    // a satellite (it partitioned the result), Icebox renders empty (subtree
    // completeness needed the extra taxonomy read); Tech — a tag at the
    // filter's altitude, another family — is out.
    expect(calls).toContain("listTags");
    expect(snapshot.nodes.filter((item) => item.resource_type === "tag").map((item) => [item.id, item.role ?? null]))
      .toEqual([["tag:graph-id", null], ["tag:icebox-id", null], ["tag:product-id", "filter-center"]]);
    expect(snapshot.hub_node_id).toBe("tag:product-id");
    expect(snapshot.edges.filter((edge) => edge.layer === "taxonomy").map((edge) => [edge.from, edge.to]))
      .toEqual([["tag:graph-id", "one"], ["tag:product-id", "two"]]);
    // The real taxonomy descent renders as hierarchy edges off the center,
    // for the used and the unused child alike.
    expect(snapshot.edges).toContainEqual(expect.objectContaining({
      from: "tag:product-id",
      to: "tag:graph-id",
      type: "tag-parent",
    }));
    expect(snapshot.edges).toContainEqual(expect.objectContaining({
      from: "tag:product-id",
      to: "tag:icebox-id",
      type: "tag-parent",
    }));
  });

  it("collects every filter tag as a center candidate", () => {
    expect(filterCenterTagTokens(normalizeViewQuery({ schema_version: 1, tags_any: ["product"] })))
      .toEqual(["product"]);
    expect(filterCenterTagTokens(normalizeViewQuery({ schema_version: 1, tags_any: ["product", "tech"] })))
      .toEqual(["product", "tech"]);
    expect(filterCenterTagTokens(normalizeViewQuery({ schema_version: 1, tags_any: ["research"], tags_all: ["product", "tech"] })))
      .toEqual(["product", "research", "tech"]);
  });
});

function assignedTag(id: string, name: string, workspaceId = "ws"): WorkspaceTag {
  return {
    id, workspace_id: workspaceId, name, normalized_name: name.toLocaleLowerCase("en-US"), slug: name.toLocaleLowerCase("en-US"),
    description: null, merged_into_id: null, deleted_at: null, created_at: "now", updated_at: "now",
  };
}

function summary(id: string, workspaceId: string, tags = [assignedTag(`tag-${workspaceId}`, "Product", workspaceId)]): KnowledgeNode {
  return {
    id, workspace_id: workspaceId, parent_id: null, kind: "doc", slug: id, title: id,
    content_md: "", data: {}, tags, status: null, priority: null, assignee_id: null, due_date: null,
    position: 0, created_by: null, created_at: "now", updated_at: "now",
  };
}
