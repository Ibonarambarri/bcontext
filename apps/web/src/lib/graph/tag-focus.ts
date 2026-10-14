import {
  buildTagHierarchyLayout,
  tagHierarchySize,
  type GraphCanonicalNodePayload,
  type GraphEdgePayload,
  type GraphResourcePayload,
  type GraphSnapshot,
  type GraphTagPayload,
  type GraphWorkspaceHub,
} from "@bcontext-dev/contract/graph/model";
import type { TagRelation, WorkspaceTag } from "@bcontext-dev/contract/types";

/** A workspace tag plus how many nodes carry it, as `GET /api/tags` returns them. */
export interface TagWithUsage extends WorkspaceTag {
  usage_count: number;
}

/** ~2.7x a low-degree tag hub (3.8) and clearly above the largest content node (~10) — "it's the center" at a glance. */
const WORKSPACE_HUB_SIZE = 12;

const tagResourceId = (tagId: string) => `tag:${tagId}`;

/**
 * The Brain graph's "Tags" focus: the snapshot the graph view renders when the
 * focus switcher is on Tags.
 *
 * It draws the taxonomy and ONLY the taxonomy: the workspace hub, every tag,
 * and the parent/related edges between them. No content nodes — nearly every
 * node carries a tag (105 of 106 in a typical workspace), so a focus that
 * included them rendered as a copy of Knowledge, and the switcher has to
 * switch something. Content lives one click away in Knowledge.
 *
 * Two sources are still merged, because neither is complete on its own —
 *
 * - the resolved graph snapshot knows how many of a tag's nodes this view
 *   actually renders, which is what should drive hub size, but only emits tags
 *   that already have at least one assignment (see `buildTaxonomyResources` in
 *   the contract), so a freshly created tag would be invisible right after you
 *   create it;
 * - `/api/tags` knows every tag and every parent/related relation, but nothing
 *   about content.
 *
 * The skeleton (hub, radial positions, parent/related edges) comes from the
 * same `buildTagHierarchyLayout` the knowledge graph uses, so both focuses
 * agree on where a tag family sits. Every position ships as
 * `pinned_positions`: this graph is fully known, so ForceAtlas2 has nothing
 * left to solve.
 */
export function buildTagFocusSnapshot({
  workspace,
  snapshot,
  tags,
  relations,
}: {
  workspace: GraphWorkspaceHub;
  snapshot: GraphSnapshot;
  tags: readonly TagWithUsage[];
  relations: readonly TagRelation[];
}): GraphSnapshot {
  const membershipCountByTag = new Map<string, number>();
  for (const edge of snapshot.edges) {
    if (edge.layer !== "taxonomy") continue;
    const tagId = edge.from.startsWith("tag:") ? edge.from : edge.to;
    membershipCountByTag.set(tagId, (membershipCountByTag.get(tagId) ?? 0) + (edge.aggregate_count ?? 1));
  }

  // Assignment counts drive hub size. Prefer what this snapshot actually
  // renders (a filtered view shows fewer members than the tag's global usage)
  // and fall back to the workspace-wide count for tags the snapshot omitted.
  const unpositionedTags: GraphTagPayload[] = tags.map((tag) => {
    const id = tagResourceId(tag.id);
    return {
      resource_type: "tag",
      id,
      title: `#${tag.name}`,
      kind: null,
      status: null,
      tags: [],
      depth: 1,
      tag: { id: tag.id, name: tag.name, slug: tag.slug, normalized_name: tag.normalized_name },
      assignment_count: membershipCountByTag.get(id) ?? tag.usage_count,
      x: 0.5,
      y: 0.5,
    };
  });

  const hub = buildTagHierarchyLayout(workspace, unpositionedTags, relations);

  const centerNode: GraphCanonicalNodePayload = {
    resource_type: "node",
    id: hub.centerId,
    title: workspace.name,
    kind: "entity",
    status: null,
    tags: [],
    depth: 0,
    x: hub.centerPosition.x,
    y: hub.centerPosition.y,
    color: hub.centerColor,
    size: WORKSPACE_HUB_SIZE,
  };

  // Size is dominated by hierarchy depth (root tags read as clearly more
  // important); usage only fine-tunes within the same depth tier.
  const depthedTags = unpositionedTags.map((tag) => ({ ...tag, depth: hub.tagDepths.get(tag.id) ?? 1 }));
  const maxAssignmentByDepth = new Map<number, number>();
  for (const tag of depthedTags) {
    maxAssignmentByDepth.set(tag.depth, Math.max(maxAssignmentByDepth.get(tag.depth) ?? 0, tag.assignment_count));
  }
  const tagNodes: GraphTagPayload[] = depthedTags.map((tag) => {
    const point = hub.tagPositions.get(tag.id) ?? hub.centerPosition;
    return {
      ...tag,
      x: point.x,
      y: point.y,
      size: tagHierarchySize(tag.depth, tag.assignment_count, maxAssignmentByDepth.get(tag.depth) ?? 0),
    };
  });

  const nodes: GraphResourcePayload[] = [centerNode, ...tagNodes];
  const edges: GraphEdgePayload[] = dedupeById(hub.edges);

  const pinnedPositions: Record<string, { x: number; y: number }> = { [hub.centerId]: hub.centerPosition };
  for (const [id, point] of hub.tagPositions) pinnedPositions[id] = point;

  const layers = uniqueLayers(edges);
  return {
    schema_version: 2,
    mode: "query",
    // Not a "centered" traversal — leaving this null keeps the renderer from
    // treating the hub as an implicit focus that dims every non-root tag.
    center_node_id: null,
    depth: 1,
    layers,
    enabled_layers: layers,
    nodes,
    edges,
    pinned_positions: pinnedPositions,
    hub_node_id: hub.centerId,
    counts: {
      // The hub is the only "node" here; every tag counts as a tag, and no
      // membership edge survives because no member does.
      visible_nodes: 1,
      hidden_nodes: 0,
      visible_tags: tagNodes.length,
      hidden_tags: 0,
      visible_edges: edges.length,
      hidden_edges: 0,
      visible_membership_edges: 0,
      hidden_membership_edges: 0,
    },
    truncated: snapshot.truncated,
    limits: snapshot.limits,
  };
}

/**
 * `buildTagHierarchyLayout` and the snapshot can both describe the same
 * tag-to-tag link; the renderer builds a graphology graph and would throw on
 * the duplicate key.
 */
function dedupeById(edges: readonly GraphEdgePayload[]): GraphEdgePayload[] {
  const byId = new Map<string, GraphEdgePayload>();
  for (const edge of edges) if (!byId.has(edge.id)) byId.set(edge.id, edge);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function uniqueLayers(edges: readonly GraphEdgePayload[]): GraphSnapshot["layers"] {
  const order: GraphSnapshot["layers"] = ["hierarchy", "taxonomy", "references", "dependencies", "semantic"];
  const present = new Set(edges.map((edge) => edge.layer));
  const layers = order.filter((layer) => present.has(layer));
  // A workspace with tags but no relations yet still needs the hierarchy
  // layer on, or the hub-to-tag spokes would have nothing to render under.
  return layers.length > 0 ? layers : ["hierarchy"];
}
