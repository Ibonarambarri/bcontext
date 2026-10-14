import { describe, expect, it } from "vitest";
import { buildGraphPayload } from "@bcontext-dev/contract/graph/model";
import type { KnowledgeNode, TagRelation, WorkspaceTag } from "@bcontext-dev/contract/types";
import { buildTagFocusSnapshot, type TagWithUsage } from "./tag-focus";

const stamp = "2026-09-08T00:00:00.000Z";
const workspace = { id: "ws", name: "Bcontext", slug: "bcontext", metadata: {} };

function tag(id: string, name: string): WorkspaceTag {
  return {
    id,
    workspace_id: "ws",
    name,
    normalized_name: name.toLowerCase(),
    slug: name.toLowerCase(),
    description: null,
    merged_into_id: null,
    deleted_at: null,
    created_at: stamp,
    updated_at: stamp,
  };
}

function node(id: string, overrides: Partial<KnowledgeNode> = {}): KnowledgeNode {
  return {
    id,
    workspace_id: "ws",
    parent_id: null,
    kind: "doc",
    slug: id,
    title: `Node ${id}`,
    content_md: "",
    data: {},
    tags: [],
    status: null,
    priority: null,
    assignee_id: null,
    due_date: null,
    position: 0,
    created_by: null,
    created_at: stamp,
    updated_at: stamp,
    ...overrides,
  };
}

const product = tag("t-product", "Product");
const graphTag = tag("t-graph", "Graph");
const empty = tag("t-empty", "Empty");

const relations: TagRelation[] = [
  { id: "rel-1", workspace_id: "ws", from_tag_id: "t-graph", to_tag_id: "t-product", relation: "parent", created_at: stamp },
  { id: "rel-2", workspace_id: "ws", from_tag_id: "t-empty", to_tag_id: "t-product", relation: "parent", created_at: stamp },
];

const withUsage = (item: WorkspaceTag, usage_count: number): TagWithUsage => ({ ...item, usage_count });

function scenario() {
  const nodes: KnowledgeNode[] = [
    node("n-doc", { tags: [product] }),
    node("n-task", { kind: "task", tags: [graphTag] }),
    node("n-lone"),
    node("n-lone-2"),
  ];
  const durableEdges = [
    { id: "e-1", workspace_id: "ws", from_node: "n-doc", to_node: "n-task", relation: "references" as const, created_at: stamp, created_by: null },
    { id: "e-2", workspace_id: "ws", from_node: "n-lone", to_node: "n-lone-2", relation: "references" as const, created_at: stamp, created_by: null },
  ];
  const snapshot = buildGraphPayload(nodes, durableEdges, nodes.map((item) => item.id), {
    mode: "query",
    workspace,
    tagRelations: relations,
  });
  return { nodes, snapshot };
}

describe("buildTagFocusSnapshot", () => {
  it("keeps every workspace tag as a hub, including tags nothing is assigned to yet", () => {
    const { snapshot } = scenario();
    const focus = buildTagFocusSnapshot({
      workspace,
      snapshot,
      tags: [withUsage(product, 1), withUsage(graphTag, 1), withUsage(empty, 0)],
      relations,
    });

    const tagIds = focus.nodes.filter((item) => item.resource_type === "tag").map((item) => item.id).sort();
    expect(tagIds).toEqual(["tag:t-empty", "tag:t-graph", "tag:t-product"]);
    expect(focus.counts.visible_tags).toBe(3);
  });

  it("draws the taxonomy alone: no content nodes, tagged or not", () => {
    const { snapshot } = scenario();
    const focus = buildTagFocusSnapshot({
      workspace,
      snapshot,
      tags: [withUsage(product, 1), withUsage(graphTag, 1)],
      relations,
    });

    // The hub is the only `node` resource; everything else is a tag.
    const contentIds = focus.nodes
      .filter((item) => item.resource_type === "node" && item.id !== focus.hub_node_id)
      .map((item) => item.id);
    expect(contentIds).toEqual([]);
    expect(focus.counts.visible_nodes).toBe(1);
    expect(focus.counts.visible_membership_edges).toBe(0);
    // This is the regression that sent the focus back to the drawing board:
    // filtering out only the UNTAGGED nodes left the focus indistinguishable
    // from Knowledge, because in a real workspace nearly everything is tagged.
    for (const id of ["n-doc", "n-task", "n-lone", "n-lone-2"]) {
      expect(focus.nodes.some((item) => item.id === id)).toBe(false);
      expect(focus.edges.some((edge) => edge.from === id || edge.to === id)).toBe(false);
    }
  });

  it("pins every rendered resource: the workspace hub and each tag", () => {
    const { snapshot } = scenario();
    const focus = buildTagFocusSnapshot({
      workspace,
      snapshot,
      tags: [withUsage(product, 1), withUsage(graphTag, 1), withUsage(empty, 0)],
      relations,
    });

    expect(focus.hub_node_id).toBe(`workspace:${workspace.id}`);
    // Fully known graph: every rendered resource is pinned, so ForceAtlas2
    // has nothing left to solve.
    expect(Object.keys(focus.pinned_positions).sort()).toEqual([
      "tag:t-empty",
      "tag:t-graph",
      "tag:t-product",
      `workspace:${workspace.id}`,
    ]);
    expect(Object.keys(focus.pinned_positions)).toHaveLength(focus.nodes.length);
  });

  it("carries the tag hierarchy: a child tag hangs off its parent, roots off the hub", () => {
    const { snapshot } = scenario();
    const focus = buildTagFocusSnapshot({
      workspace,
      snapshot,
      tags: [withUsage(product, 1), withUsage(graphTag, 1), withUsage(empty, 0)],
      relations,
    });

    expect(focus.edges).toContainEqual(expect.objectContaining({
      from: "tag:t-product",
      to: "tag:t-graph",
      layer: "hierarchy",
    }));
    expect(focus.edges).toContainEqual(expect.objectContaining({
      from: `workspace:${workspace.id}`,
      to: "tag:t-product",
      layer: "hierarchy",
    }));
  });

  it("emits no duplicate edge ids — the renderer keys a graphology graph by them", () => {
    const { snapshot } = scenario();
    const focus = buildTagFocusSnapshot({
      workspace,
      snapshot,
      tags: [withUsage(product, 1), withUsage(graphTag, 1), withUsage(empty, 0)],
      relations,
    });

    const ids = focus.edges.map((edge) => edge.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Every edge must land on a rendered resource.
    const rendered = new Set(focus.nodes.map((item) => item.id));
    for (const edge of focus.edges) {
      expect(rendered.has(edge.from)).toBe(true);
      expect(rendered.has(edge.to)).toBe(true);
    }
  });

  it("sizes a tag hub by what the snapshot renders, not its global usage count", () => {
    const { snapshot } = scenario();
    const focus = buildTagFocusSnapshot({
      workspace,
      snapshot,
      // `usage_count` is workspace-wide; this snapshot only carries one node
      // per tag, and a filtered Brain view would carry fewer still.
      tags: [withUsage(product, 99), withUsage(graphTag, 99), withUsage(empty, 7)],
      relations,
    });

    const byId = new Map(focus.nodes.filter((item) => item.resource_type === "tag").map((item) => [item.id, item]));
    expect(byId.get("tag:t-product")?.assignment_count).toBe(1);
    // No memberships in the snapshot at all — fall back to the global count.
    expect(byId.get("tag:t-empty")?.assignment_count).toBe(7);
  });

  it("returns a tags-only graph when the workspace has no tags at all", () => {
    const { snapshot } = scenario();
    const focus = buildTagFocusSnapshot({ workspace, snapshot, tags: [], relations: [] });

    expect(focus.nodes).toHaveLength(1);
    expect(focus.nodes[0]?.id).toBe(`workspace:${workspace.id}`);
    expect(focus.edges).toEqual([]);
    expect(focus.layers).toEqual(["hierarchy"]);
  });
});
