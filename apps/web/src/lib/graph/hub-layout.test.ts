import { describe, expect, it } from "vitest";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { buildGraphPayload, type GraphLayer, type GraphSnapshot } from "@bcontext-dev/contract/graph/model";
import { filterVisibleGraphLayer, foldGraphTags, graphNodeSizes } from "./presentation";
import type { KnowledgeNode, TagRelation, WorkspaceTag } from "@bcontext-dev/contract/types";

const stamp = "2026-07-20T00:00:00.000Z";

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

/**
 * Synthetic equivalent of the reported production workspace: 179 nodes,
 * 12 tags in a 3-root hierarchy, 14 tag relations — plus a realistic share
 * of untagged nodes (some fully isolated, some linked only to each other)
 * that have no anchor in the tag-first radial layout.
 */
function syntheticWorkspace() {
  const tags = [
    tag("t-product", "Product"), // root 1
    tag("t-eng", "Engineering"), // root 2
    tag("t-biz", "Business"), // root 3
    tag("t-graph", "Graph"),
    tag("t-mcp", "MCP"),
    tag("t-api", "API"),
    tag("t-infra", "Infra"),
    tag("t-pricing", "Pricing"),
    tag("t-research", "Research"),
    tag("t-ui", "UI"),
    tag("t-rag", "RAG"),
    tag("t-docs", "Docs"),
  ];
  const parent = (child: string, parentId: string, index: number): TagRelation => ({
    id: `rel-${index}`,
    workspace_id: "ws",
    from_tag_id: child,
    to_tag_id: parentId,
    relation: "parent",
    created_at: stamp,
  });
  const related = (from: string, to: string, index: number): TagRelation => ({
    id: `rel-${index}`,
    workspace_id: "ws",
    from_tag_id: from,
    to_tag_id: to,
    relation: "related",
    created_at: stamp,
  });
  const relations: TagRelation[] = [
    parent("t-graph", "t-product", 1),
    parent("t-mcp", "t-product", 2),
    parent("t-api", "t-eng", 3),
    parent("t-infra", "t-eng", 4),
    parent("t-pricing", "t-biz", 5),
    parent("t-research", "t-biz", 6),
    parent("t-ui", "t-product", 7),
    parent("t-rag", "t-eng", 8),
    parent("t-docs", "t-product", 9),
    parent("t-rag", "t-graph", 10), // multi-parent
    related("t-graph", "t-rag", 11),
    related("t-api", "t-mcp", 12),
    related("t-pricing", "t-product", 13),
    related("t-docs", "t-ui", 14),
  ];

  const taggableTags = tags.filter((item) => item.id !== "t-biz");
  const nodes: KnowledgeNode[] = [];
  // 139 tagged nodes spread over the taxonomy; heavy skew toward one branch
  // (like a real workspace where one product area dominates).
  for (let index = 0; index < 139; index++) {
    const primary = index % 3 === 0
      ? taggableTags[index % 4]! // skew toward the first branch
      : taggableTags[index % taggableTags.length]!;
    const secondary = index % 11 === 0
      ? [taggableTags[(index + 5) % taggableTags.length]!]
      : [];
    nodes.push(node(`tagged-${String(index).padStart(3, "0")}`, {
      kind: index % 3 === 0 ? "task" : index % 3 === 1 ? "doc" : "decision",
      tags: [primary, ...secondary],
    }));
  }
  // 34 fully isolated untagged nodes.
  for (let index = 0; index < 34; index++) {
    nodes.push(node(`orphan-${String(index).padStart(2, "0")}`));
  }
  // 3 untagged pairs connected only to each other (still anchorless).
  for (let index = 0; index < 6; index++) {
    nodes.push(node(`pair-${String(index).padStart(2, "0")}`));
  }
  const edges = [0, 2, 4].map((index) => ({
    id: `edge-pair-${index}`,
    workspace_id: "ws",
    from_node: `pair-${String(index).padStart(2, "0")}`,
    to_node: `pair-${String(index + 1).padStart(2, "0")}`,
    relation: "references" as const,
    created_at: stamp,
    created_by: null,
  }));

  return { tags, relations, nodes, edges };
}

const workspace = { id: "ws", name: "Bcontext", slug: "bcontext", metadata: {} };

/** Mirror of the renderer constants (graph-renderer.tsx). */
const LAYOUT_EDGE_WEIGHTS: Record<GraphLayer, number> = {
  taxonomy: 3.0,
  hierarchy: 1.25,
  dependencies: 0.7,
  references: 0.38,
  semantic: 0.22,
};
const DEFAULT_ENABLED: ReadonlySet<GraphLayer> = new Set(["hierarchy", "taxonomy", "references", "dependencies"]);

/**
 * Reproduce the renderer's ForceAtlas2 pass (same settings as
 * graph-renderer.tsx `runLayout(full)`) on a snapshot, honoring
 * `pinned_positions` exactly like `reconcileOrganicGraph` does
 * (`fixed: Boolean(persisted)`). Returns graph-space positions
 * (normalized × 100, hub at the origin).
 */
function simulateRendererLayout(snapshot: GraphSnapshot): Map<string, { x: number; y: number }> {
  const sizes = graphNodeSizes(snapshot.nodes, snapshot.edges);
  const graph = new Graph({ multi: true, type: "mixed" });
  for (const resource of snapshot.nodes) {
    graph.addNode(resource.id, {
      x: (resource.x - 0.5) * 100,
      y: (resource.y - 0.5) * 100,
      size: sizes.get(resource.id) ?? 6,
      fixed: Boolean(snapshot.pinned_positions[resource.id]),
    });
  }
  for (const edge of snapshot.edges) {
    if (!DEFAULT_ENABLED.has(edge.layer)) continue;
    if (edge.directed) graph.addDirectedEdgeWithKey(edge.id, edge.from, edge.to, { layer: edge.layer });
    else graph.addUndirectedEdgeWithKey(edge.id, edge.from, edge.to, { layer: edge.layer });
  }
  forceAtlas2.assign(graph, {
    iterations: 300,
    settings: {
      adjustSizes: true,
      barnesHutOptimize: graph.order > 120,
      barnesHutTheta: 0.6,
      edgeWeightInfluence: 1,
      gravity: graph.order > 150 ? 0.6 : 0.45,
      scalingRatio: graph.order <= 20 ? 3 : graph.order > 250 ? 8.5 : 5.5,
      slowDown: graph.order > 300 ? 7 : 5,
      strongGravityMode: false,
    },
    getEdgeWeight: (_edge: string, attributes: { layer: GraphLayer }) => LAYOUT_EDGE_WEIGHTS[attributes.layer],
  });
  const out = new Map<string, { x: number; y: number }>();
  graph.forEachNode((id, attributes) => out.set(id, { x: attributes.x as number, y: attributes.y as number }));
  return out;
}

describe("knowledge-graph hub layout — anchorless clump regression", () => {
  const { relations, nodes, edges } = syntheticWorkspace();
  const snapshot = buildGraphPayload(nodes, edges, nodes.map((item) => item.id), {
    mode: "query",
    workspace,
    tagRelations: relations,
  });
  const hubId = snapshot.hub_node_id!;

  it("builds the expected synthetic shape", () => {
    expect(hubId).toBe("workspace:ws");
    expect(snapshot.nodes.filter((item) => item.resource_type === "tag")).toHaveLength(11); // t-biz has no members
    expect(snapshot.nodes).toHaveLength(1 + 11 + 179);
  });

  it("seeds every non-hub resource at least 0.045 from the hub", () => {
    for (const resource of snapshot.nodes) {
      if (resource.id === hubId) continue;
      const distance = Math.hypot(resource.x - 0.5, resource.y - 0.5);
      expect(distance, `${resource.id} seeded at ${distance.toFixed(4)}`).toBeGreaterThanOrEqual(0.045 - 1e-9);
    }
  });

  it("spaces the hub orbit — no stacked pile of untagged nodes over the hub (regression)", () => {
    // The seed layout IS the final render whenever ForceAtlas2 is skipped
    // (prefers-reduced-motion) and the first painted frame otherwise. The old
    // jittered 0.045–0.075 ring squeezed all 40 anchorless nodes into one
    // thin annulus on the hub glyph; the sunflower orbit must keep them
    // mutually separated and clear of the first tag ring (0.16).
    const orbitNodes = snapshot.nodes.filter((resource) =>
      resource.id.startsWith("orphan-") || resource.id.startsWith("pair-"));
    expect(orbitNodes).toHaveLength(40);
    const points = orbitNodes.map((resource) => ({ id: resource.id, x: resource.x, y: resource.y }));
    for (const point of points) {
      const fromHub = Math.hypot(point.x - 0.5, point.y - 0.5);
      expect(fromHub, `${point.id} at ${fromHub.toFixed(3)} from hub`).toBeGreaterThanOrEqual(0.05);
      expect(fromHub, `${point.id} bleeds into the tag ring`).toBeLessThanOrEqual(0.13);
    }
    let minSeparation = Infinity;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        minSeparation = Math.min(
          minSeparation,
          Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y),
        );
      }
    }
    // Old ring: min pairwise separation collapsed under 0.002 (fully stacked).
    expect(minSeparation).toBeGreaterThanOrEqual(0.01);
  });

  it("pins anchorless components so ForceAtlas2 can neither sink them onto the hub nor fling them away", () => {
    for (const resource of snapshot.nodes) {
      if (!resource.id.startsWith("orphan-") && !resource.id.startsWith("pair-")) continue;
      expect(snapshot.pinned_positions[resource.id], `${resource.id} must be pinned`).toEqual({ x: resource.x, y: resource.y });
    }
    // Tag-anchored content stays free for the force pass.
    expect(snapshot.pinned_positions["tagged-000"]).toBeUndefined();
  });

  it("keeps every node off the hub after the renderer's ForceAtlas2 pass", () => {
    const settled = simulateRendererLayout(snapshot);
    const hub = settled.get(hubId)!;
    expect(Math.hypot(hub.x, hub.y)).toBeLessThan(1e-6); // landmark never moves
    // Graph-space threshold: 4.5 units = 0.045 normalized — the historical
    // clump left dozens of nodes covering the hub glyph.
    for (const [id, point] of settled) {
      if (id === hubId) continue;
      const distance = Math.hypot(point.x - hub.x, point.y - hub.y);
      expect(distance, `${id} settled ${distance.toFixed(2)} units from the hub`).toBeGreaterThanOrEqual(4.5);
    }
    // Pinned orbit nodes stay exactly where the engine placed them instead of
    // being flung to the periphery (free isolated nodes ended 85+ units out).
    for (const resource of snapshot.nodes) {
      if (!resource.id.startsWith("orphan-")) continue;
      const point = settled.get(resource.id)!;
      expect(point.x).toBeCloseTo((resource.x - 0.5) * 100, 6);
      expect(point.y).toBeCloseTo((resource.y - 0.5) * 100, 6);
    }
  });

  it("carries the hub's explicit size 12 and hex color through fold → layer filter → sizing", () => {
    const folded = foldGraphTags(snapshot.nodes, snapshot.edges, new Set());
    const visible = filterVisibleGraphLayer(folded, DEFAULT_ENABLED, new Set());
    const hubResource = visible.nodes.find((resource) => resource.id === hubId)!;
    expect(hubResource).toBeDefined();

    const sizes = graphNodeSizes(visible.nodes, visible.edges);
    expect(sizes.get(hubId)).toBe(12);
    for (const [id, size] of sizes) {
      if (id === hubId) continue;
      expect(size, `${id} must render smaller than the hub`).toBeLessThan(12);
    }

    // Sigma only parses legacy CSS colors — an oklch() hub silently renders
    // as opaque black. The engine must hand over hex on the payload itself,
    // which is what makes it survive `resolveResourceColor`'s first branch.
    expect(hubResource!.color).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
