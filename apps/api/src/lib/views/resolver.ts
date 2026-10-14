/**
 * Turns a view query into the ordered set of node ids it selects — the same
 * answer for a saved view, an ad-hoc `POST /api/views/resolve`, the MCP
 * `views`/`nodes(op=list)` tools and `brief`.
 *
 * Reads only through the `Storage` it is given, so the caller's reach is the
 * outer bound of every result. Cost is estimated before any read and refused
 * above `VIEW_LIMITS.maxResolverCost`; traversals and results are capped so a
 * pathological query degrades to `truncated: true` rather than to a timeout.
 */
import { getNodeTags, type KnowledgeNode, type TagRelation } from "@bcontext-dev/contract/types";
import type { NodeEdge, Storage } from "@/lib/storage";
import { expandTagIdsWithDescendants } from "@bcontext-dev/contract/tag-hierarchy";
import { normalizeViewQuery, VIEW_LIMITS, type ViewQuery } from "@bcontext-dev/contract/views/schema";
import type { ResolvedViewQuery } from "@bcontext-dev/contract/views/types";
import { indexBlockers, isUnblocked } from "@/lib/views/unblocked";

/** Thrown before any read: the query is refused, not partially answered. */
export class ViewQueryCostError extends Error {
  constructor(public readonly estimatedCost: number) {
    super(`query cost ${estimatedCost} exceeds hard limit ${VIEW_LIMITS.maxResolverCost}`);
    this.name = "ViewQueryCostError";
  }
}

/**
 * Optional pre-fetched workspace reads. A route that resolves a view AND
 * builds its renderer payload (graph snapshot, board blockers) passes the
 * index/edges it already loaded so one request never issues the same bounded
 * workspace query twice.
 */
export interface ViewResolvePreload {
  nodes?: KnowledgeNode[];
  edges?: NodeEdge[];
}

/** Normalize, cost-check, match, then cap and sort ids for a stable payload. */
export async function resolveViewQuery(
  storage: Storage,
  input: unknown,
  preload: ViewResolvePreload = {},
): Promise<ResolvedViewQuery> {
  const query = normalizeViewQuery(input);
  const estimatedCost = estimateQueryCost(query);
  if (estimatedCost > VIEW_LIMITS.maxResolverCost) throw new ViewQueryCostError(estimatedCost);

  const matched = await matchViewQuery(storage, query, preload);
  let truncated = matched.truncated;
  const ids = [...new Set(matched.nodes.map((node) => node.id))].sort((a, b) => a.localeCompare(b));
  if (ids.length > VIEW_LIMITS.maxResultNodes) truncated = true;
  const nodeIds = ids.slice(0, VIEW_LIMITS.maxResultNodes);
  return {
    node_ids: nodeIds,
    total: ids.length,
    applied_filters: query,
    scope: {
      type: query.traversal ? "neighborhood" : query.root_node_ids.length > 0 ? "roots" : "workspace",
      workspace_id: storage.workspace.id,
      root_node_ids: query.root_node_ids,
      traversed_edges: matched.traversedEdges,
      estimated_cost: estimatedCost,
      truncated,
      limits: {
        max_result_nodes: VIEW_LIMITS.maxResultNodes,
        max_traversal_nodes: VIEW_LIMITS.maxTraversalNodes,
        max_traversal_edges: VIEW_LIMITS.maxTraversalEdges,
        max_traversal_depth: VIEW_LIMITS.maxTraversalDepth,
        max_resolver_cost: VIEW_LIMITS.maxResolverCost,
      },
    },
  };
}

export interface MatchedViewQuery {
  /** Matching nodes in index order — not sorted, not capped. */
  nodes: KnowledgeNode[];
  traversedEdges: number;
  /** True when a traversal cap cut the expansion short. */
  truncated: boolean;
}

/**
 * The filter half of `resolveViewQuery`, for callers that want the nodes in
 * index order and uncapped: the MCP `nodes(op=list)` pages and orders on its
 * own but must apply exactly the same predicate a saved view does, or "what
 * can I start now" gives two answers depending on who asked.
 *
 * `query` must already be normalized (see `normalizeViewQuery`).
 */
export async function matchViewQuery(
  storage: Storage,
  query: ViewQuery,
  preload: ViewResolvePreload = {},
): Promise<MatchedViewQuery> {
  // Storage is workspace-bound by contract; re-assert it here so a faulty
  // adapter/cache can never turn a view filter into a tenant boundary.
  const readIndex = storage.listNodeSummaries?.bind(storage) ?? storage.listNodes.bind(storage);
  const nodes = (preload.nodes ?? await readIndex({ limit: 5_000 })).filter(
    (node) => node.workspace_id === storage.workspace.id,
  );
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const rootScope = collectRootScope(nodes, byId, query.root_node_ids);
  const hasTagFilter = query.tags_any.length + query.tags_all.length > 0;
  const resolvedTagIds = hasTagFilter
    ? await storage.resolveTagIds([...query.tags_any, ...query.tags_all])
    : new Map<string, string>();
  // Tag filters inherit through the tag hierarchy: filtering by T also
  // matches nodes tagged with any descendant of T. Resolved at query time
  // from tag_relations — node_tags stays direct-only. O(refs × relations).
  const tagDescendants = hasTagFilter
    ? collectTagDescendants(query, resolvedTagIds, await storage.listTagRelations())
    : new Map<string, Set<string>>();
  let filtered = nodes.filter((node) =>
    (query.traversal || rootScope === null || rootScope.has(node.id)) && matchesNode(node, query, resolvedTagIds, tagDescendants),
  );
  let traversedEdges = 0;
  let truncated = false;

  // Edges are read once and only when a filter needs them.
  const edges = query.traversal || query.unblocked ? preload.edges ?? await storage.listEdges() : [];

  if (query.traversal) {
    const expansion = expandTraversal(query, edges, byId, rootScope ?? new Set(query.root_node_ids));
    traversedEdges = expansion.traversedEdges;
    truncated = expansion.truncated;
    const allowed = expansion.nodeIds;
    filtered = filtered.filter((node) => allowed.has(node.id));
  }

  if (query.unblocked) {
    // Dependencies are evaluated against the whole index, not the filtered
    // set: a tag or kind filter may hide a task's blocker, and a hidden
    // blocker must still block — it is not a deleted one.
    const blockers = indexBlockers(edges);
    filtered = filtered.filter((node) => isUnblocked(node, blockers, byId));
  }

  return { nodes: filtered, traversedEdges, truncated };
}

export function estimateQueryCost(query: ViewQuery): number {
  const traversal = query.traversal;
  if (!traversal) return VIEW_LIMITS.maxResultNodes;
  return query.root_node_ids.length * traversal.depth * Math.min(traversal.max_edges, VIEW_LIMITS.maxTraversalEdges);
}

function matchesNode(node: KnowledgeNode, query: ViewQuery, resolvedTagIds: Map<string, string>, tagDescendants: Map<string, Set<string>>): boolean {
  if (query.kinds.length > 0 && !query.kinds.includes(node.kind)) return false;
  if (query.statuses.length > 0 && (!node.status || !query.statuses.includes(node.status))) return false;
  // Archived is out of the way by default: a view that does not name it
  // never shows it, so boards, graphs and lists stay about live work.
  if (query.statuses.length === 0 && node.status === "archived") return false;
  const tags = new Set([
    ...getNodeTags(node).map((tag) => tag.toLocaleLowerCase("en-US")),
    ...node.tags.flatMap((tag) => [tag.id, tag.slug, tag.normalized_name]).map((tag) => tag.toLocaleLowerCase("en-US")),
  ]);
  const hasTag = (tag: string) => {
    const normalized = tag.toLocaleLowerCase("en-US");
    const resolvedId = resolvedTagIds.get(normalized);
    if (tags.has(normalized)) return true;
    if (resolvedId && tags.has(resolvedId.toLocaleLowerCase("en-US"))) return true;
    const descendants = tagDescendants.get(normalized);
    if (descendants) for (const id of descendants) if (tags.has(id)) return true;
    return false;
  };
  if (query.tags_any.length > 0 && !query.tags_any.some(hasTag)) return false;
  if (query.tags_all.length > 0 && !query.tags_all.every(hasTag)) return false;
  const source = typeof node.data.source === "string" ? node.data.source.toLocaleLowerCase("en-US") : null;
  if (query.source.length > 0 && (!source || !query.source.some((value) => value.toLocaleLowerCase("en-US") === source))) return false;
  if (query.actor.length > 0 && (!node.created_by || !query.actor.includes(node.created_by))) return false;
  for (const range of query.dates) {
    const value = node[range.field];
    if (!value) return false;
    const timestamp = Date.parse(value);
    if (range.from && timestamp < Date.parse(range.from)) return false;
    if (range.to && timestamp > Date.parse(range.to)) return false;
  }
  return true;
}

/**
 * For each requested tag reference (tags_any/tags_all), the lowercased tag
 * ids that satisfy it through the hierarchy: the referenced tag plus every
 * descendant. Seeds cover both the raw reference (it may already be a tag
 * id) and its alias-resolved id; unresolvable name references simply expand
 * to themselves and keep the existing direct-match behavior.
 */
function collectTagDescendants(
  query: ViewQuery,
  resolvedTagIds: Map<string, string>,
  relations: TagRelation[],
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  if (relations.length === 0) return index;
  for (const ref of [...query.tags_any, ...query.tags_all]) {
    const normalized = ref.toLocaleLowerCase("en-US");
    if (index.has(normalized)) continue;
    const seeds = [ref];
    const resolvedId = resolvedTagIds.get(normalized);
    if (resolvedId) seeds.push(resolvedId);
    const expanded = expandTagIdsWithDescendants(seeds, relations);
    index.set(normalized, new Set([...expanded].map((id) => id.toLocaleLowerCase("en-US"))));
  }
  return index;
}

function collectRootScope(nodes: KnowledgeNode[], byId: Map<string, KnowledgeNode>, roots: string[]): Set<string> | null {
  if (roots.length === 0) return null;
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parent_id) continue;
    children.set(node.parent_id, [...(children.get(node.parent_id) ?? []), node.id]);
  }
  const scoped = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (scoped.has(id) || !byId.has(id)) continue;
    scoped.add(id);
    queue.push(...(children.get(id) ?? []));
  }
  return scoped;
}

function expandTraversal(query: ViewQuery, edges: NodeEdge[], byId: Map<string, KnowledgeNode>, initial: Set<string>) {
  const traversal = query.traversal!;
  const allowedTypes = new Set(traversal.edge_types);
  const adjacency = new Map<string, string[]>();
  const add = (from: string, to: string) => adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
  for (const edge of edges) {
    if (allowedTypes.size > 0 && !allowedTypes.has(edge.relation)) continue;
    if (traversal.direction !== "incoming") add(edge.from_node, edge.to_node);
    if (traversal.direction !== "outgoing") add(edge.to_node, edge.from_node);
  }
  for (const [id, neighbors] of adjacency) adjacency.set(id, [...new Set(neighbors)].sort());

  const orderedInitial = [
    ...query.root_node_ids.filter((id) => initial.has(id) && byId.has(id)),
    ...[...initial].filter((id) => !query.root_node_ids.includes(id) && byId.has(id)).sort(),
  ];
  const nodeIds = new Set(orderedInitial.slice(0, traversal.max_nodes));
  let frontier = [...nodeIds].sort();
  let traversedEdges = 0;
  let truncated = orderedInitial.length > traversal.max_nodes;
  for (let depth = 0; depth < traversal.depth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        traversedEdges++;
        if (traversedEdges > traversal.max_edges) { truncated = true; break; }
        if (!byId.has(neighbor) || nodeIds.has(neighbor)) continue;
        if (nodeIds.size >= traversal.max_nodes) { truncated = true; break; }
        nodeIds.add(neighbor);
        next.push(neighbor);
      }
      if (truncated) break;
    }
    frontier = [...new Set(next)].sort();
    if (truncated) break;
  }
  return { nodeIds, traversedEdges: Math.min(traversedEdges, traversal.max_edges), truncated };
}
