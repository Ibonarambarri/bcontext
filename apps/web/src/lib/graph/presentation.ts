/**
 * Pure transforms between the graph snapshot the API returns
 * (`GraphResourcePayload`/`GraphEdgePayload`) and what sigma is asked to draw:
 * folding exclusive tag members into their hub, hiding disabled layers, and
 * sizing nodes by weighted degree. `graph-renderer.tsx` is the one caller
 * (every graph view goes through it), so a fold or a layer toggle means the
 * same thing on every surface.
 */
import type {
  GraphEdgePayload,
  GraphLayer,
  GraphResourcePayload,
} from "@bcontext-dev/contract/graph/model";

/** How much an edge of each layer counts towards a node's size; semantic links are the noisiest. */
const LAYER_DEGREE_WEIGHT: Record<GraphLayer, number> = {
  hierarchy: 0.8,
  taxonomy: 0.32,
  references: 1,
  dependencies: 1.15,
  semantic: 0.24,
};

/** The snapshot after folding: `hidden_node_ids` are the members absorbed into a tag hub. */
export interface FoldedGraph {
  nodes: GraphResourcePayload[];
  edges: GraphEdgePayload[];
  folded_member_counts: Map<string, number>;
  hidden_node_ids: Set<string>;
}

/**
 * Fold only exclusive tag members. A node assigned to two or more tags stays
 * visible as a boundary bridge, so folding never destroys cross-tag context.
 * Relationships that cross a folded boundary are aggregated onto the tag hub.
 */
export function foldGraphTags(
  nodes: GraphResourcePayload[],
  edges: GraphEdgePayload[],
  foldedTagIds: ReadonlySet<string>,
): FoldedGraph {
  const resourceIds = new Set(nodes.map((node) => node.id));
  const normalizedFolded = new Set(
    [...foldedTagIds]
      .map((id) => id.startsWith("tag:") ? id : `tag:${id}`)
      .filter((id) => resourceIds.has(id)),
  );
  const tagsByNode = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.layer !== "taxonomy") continue;
    const tagId = edge.from.startsWith("tag:") ? edge.from : edge.to;
    const nodeId = edge.from === tagId ? edge.to : edge.from;
    if (!resourceIds.has(tagId) || !resourceIds.has(nodeId)) continue;
    const tags = tagsByNode.get(nodeId) ?? new Set<string>();
    tags.add(tagId);
    tagsByNode.set(nodeId, tags);
  }

  const hiddenNodeIds = new Set<string>();
  const replacement = new Map<string, string>();
  const foldedMemberCounts = new Map<string, number>();
  for (const node of nodes) {
    if (node.resource_type !== "node") continue;
    const memberships = tagsByNode.get(node.id);
    if (!memberships || memberships.size !== 1) continue;
    const [onlyTag] = memberships;
    if (!onlyTag || !normalizedFolded.has(onlyTag)) continue;
    hiddenNodeIds.add(node.id);
    replacement.set(node.id, onlyTag);
    foldedMemberCounts.set(onlyTag, (foldedMemberCounts.get(onlyTag) ?? 0) + 1);
  }

  const visibleNodes = nodes.filter((node) => !hiddenNodeIds.has(node.id));
  const untouched: GraphEdgePayload[] = [];
  const aggregated = new Map<string, GraphEdgePayload & { count: number }>();
  for (const edge of edges) {
    if (edge.layer === "taxonomy") {
      const memberId = edge.from.startsWith("tag:") ? edge.to : edge.from;
      if (!hiddenNodeIds.has(memberId)) untouched.push(edge);
      continue;
    }
    const from = replacement.get(edge.from) ?? edge.from;
    const to = replacement.get(edge.to) ?? edge.to;
    if (from === to) continue;
    const wasFolded = from !== edge.from || to !== edge.to;
    if (!wasFolded) {
      untouched.push(edge);
      continue;
    }
    const directionKey = edge.directed ? `${from}>${to}` : [from, to].sort().join("~");
    const key = `folded:${edge.layer}:${edge.type}:${directionKey}`;
    const current = aggregated.get(key);
    if (current) current.count += edge.aggregate_count ?? 1;
    else aggregated.set(key, {
      ...edge,
      id: key,
      from,
      to,
      virtual: true,
      count: edge.aggregate_count ?? 1,
    });
  }

  const foldedEdges = [...aggregated.values()].map(({ count, ...edge }) => ({
    ...edge,
    label: count > 1 ? `${count} links` : edge.label,
    aggregate_count: count,
  }));

  return {
    nodes: visibleNodes,
    edges: [...untouched, ...foldedEdges].sort((a, b) => a.id.localeCompare(b.id)),
    folded_member_counts: foldedMemberCounts,
    hidden_node_ids: hiddenNodeIds,
  };
}

/**
 * Layer-toggle visibility for an already-folded graph. A tag hub stays on
 * screen whenever it carries at least one edge in a currently-enabled
 * layer — taxonomy membership is the common case, but a snapshot may hang
 * tags off `hierarchy`/`references` edges instead, and those must not
 * vanish just because the unrelated "taxonomy" toggle happens to be off.
 * Root-caused here (rather than in the renderer) so the contract is one
 * place: a previous renderer-only check — "show tags only if the taxonomy
 * layer is on" — silently dropped every tag and edge in a taxonomy-less
 * snapshot.
 */
export function filterVisibleGraphLayer(
  folded: Pick<FoldedGraph, "nodes" | "edges">,
  enabledLayers: ReadonlySet<GraphLayer>,
  foldedTagIds: ReadonlySet<string>,
): { nodes: GraphResourcePayload[]; edges: GraphEdgePayload[] } {
  const renderableEdges = folded.edges.filter((edge) => enabledLayers.has(edge.layer));
  const connectedTagIds = new Set(renderableEdges.flatMap((edge) => [edge.from, edge.to]));
  // Accept both raw and `tag:`-prefixed folded ids, like foldGraphTags does.
  const foldedRawIds = new Set([...foldedTagIds].map((id) => (id.startsWith("tag:") ? id.slice(4) : id)));
  const nodes = folded.nodes.filter((node) =>
    node.resource_type !== "tag" || connectedTagIds.has(node.id) || foldedRawIds.has(node.tag.id),
  );
  const visibleIds = new Set(nodes.map((node) => node.id));
  const edges = renderableEdges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  return { nodes, edges };
}

/** A restrained logarithmic scale: connection-rich nodes gain hierarchy without becoming labels. */
export function graphNodeSizes(
  nodes: GraphResourcePayload[],
  edges: GraphEdgePayload[],
): Map<string, number> {
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    const contribution = LAYER_DEGREE_WEIGHT[edge.layer] * (edge.aggregate_count ?? 1);
    if (degree.has(edge.from)) degree.set(edge.from, degree.get(edge.from)! + contribution);
    if (degree.has(edge.to)) degree.set(edge.to, degree.get(edge.to)! + contribution);
  }
  // Nodes with an explicit `size` override (e.g. the workspace hub) opt out
  // of the degree-derived scale entirely — including out of the p95 pool, so
  // a highly-connected hub cannot shrink everyone else's sizes.
  const contentDegrees = nodes
    .filter((node) => node.resource_type === "node" && node.size === undefined)
    .map((node) => degree.get(node.id) ?? 0)
    .sort((a, b) => a - b);
  const p95 = contentDegrees[Math.max(0, Math.ceil(contentDegrees.length * 0.95) - 1)] ?? 1;
  const denominator = Math.log1p(Math.max(1, p95));

  return new Map(nodes.map((node) => {
    if (typeof node.size === "number") return [node.id, node.size];
    const normalized = Math.min(1, Math.log1p(degree.get(node.id) ?? 0) / denominator);
    if (node.resource_type === "tag") return [node.id, 3.8 + normalized * 2.2];
    if (node.resource_type === "cluster") return [node.id, 7 + normalized * 3];
    return [node.id, 5.8 + normalized * 4.2];
  }));
}


