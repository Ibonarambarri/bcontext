/**
 * Builds the graph renderer's payload for a resolved view: the nodes the
 * query selected plus the tag chain that explains *why* (the filter tags and
 * their descendants), so the client can draw the taxonomy around the result.
 *
 * Called from `POST /api/views/:id/resolve` after `resolveViewQuery`, sharing
 * that request's preloaded index so the workspace is read once. Every read is
 * a bounded batch — never one query per node or per tag.
 */
import type { Storage } from "@/lib/storage";
import { expandTagIdsWithDescendants } from "@bcontext-dev/contract/tag-hierarchy";
import type { ViewQuery } from "@bcontext-dev/contract/views/schema";
import type { SavedView, ResolvedViewQuery } from "@bcontext-dev/contract/views/types";
import { buildGraphPayload, type GraphBuildOptions, type GraphLayer, type GraphSnapshot } from "@bcontext-dev/contract/graph/model";

/** Pre-fetched reads shared with the resolver so one request reads once. */
export interface GraphSnapshotPreload {
  nodes?: Awaited<ReturnType<Storage["listNodeSummaries"]>>;
  edges?: Awaited<ReturnType<Storage["listEdges"]>>;
}

/** Resolve a graph view with bounded batch reads, never N+1. */
export async function buildGraphViewSnapshot(
  storage: Storage,
  view: SavedView,
  result: ResolvedViewQuery,
  preload: GraphSnapshotPreload = {},
): Promise<GraphSnapshot> {
  const readIndex = storage.listNodeSummaries?.bind(storage) ?? storage.listNodes.bind(storage);
  const implicitTagTokens = filterCenterTagTokens(result.applied_filters);
  const [nodes, edges, tagRelations] = await Promise.all([
    preload.nodes ?? readIndex({ limit: 5_000 }),
    preload.edges ?? storage.listEdges(),
    // Optional chaining: some in-memory test doubles don't implement this
    // yet — degrade to "no relations known" rather than failing the view.
    storage.listTagRelations?.() ?? Promise.resolve([]),
  ]);
  const workspaceNodes = nodes.filter((node) => node.workspace_id === storage.workspace.id);
  const currentImplicitTags = currentTagIdsByToken(implicitTagTokens, workspaceNodes, result.node_ids);
  const unresolvedTokens = implicitTagTokens.filter((token) => !currentImplicitTags.has(token));
  // Current names, slugs and stable ids resolve from the already-loaded node
  // summaries. Only historical aliases need one extra bounded taxonomy read.
  const resolvedAliases = unresolvedTokens.length > 0 && result.node_ids.length > 0
    ? await storage.resolveTagIds(unresolvedTokens)
    : new Map<string, string>();
  const filterTagIds = implicitTagTokens.flatMap((token) => {
    const id = currentImplicitTags.get(token) ?? resolvedAliases.get(token);
    return id ? [id] : [];
  });
  // Chain descriptors (the filter tag(s) plus their complete descendant
  // subtree): usually recoverable from the node summaries already in hand; a
  // chain tag nobody in the workspace carries — a center matched only
  // through descendants, or an unused child that must still render so the
  // filter's subtree stays complete — needs one extra bounded taxonomy read.
  const chainTagIds = filterTagIds.length > 0
    ? expandTagIdsWithDescendants(filterTagIds, tagRelations)
    : new Set<string>();
  const chainTagById = new Map<string, { id: string; name: string; slug: string; normalized_name: string }>();
  if (chainTagIds.size > 0) {
    for (const node of workspaceNodes) {
      for (const tag of node.tags) {
        if (tag.deleted_at || tag.merged_into_id) continue;
        if (chainTagIds.has(tag.id) && !chainTagById.has(tag.id)) chainTagById.set(tag.id, tag);
      }
    }
    if (chainTagById.size < chainTagIds.size && storage.listTags) {
      for (const tag of await storage.listTags()) {
        if (chainTagIds.has(tag.id) && !chainTagById.has(tag.id)) chainTagById.set(tag.id, tag);
      }
    }
  }
  const centerTags = filterTagIds.flatMap((id) => {
    const descriptor = chainTagById.get(id);
    return descriptor ? [descriptor] : [];
  });
  const config: GraphBuildOptions = {
    // Filter semantics: the filter tag(s) ARE the center of a filtered graph
    // view — `pickCenterTags` promotes the highest-hierarchy one(s), ties
    // become connected co-centers, and the workspace hub is skipped. The
    // filter tags are never hidden as "redundant": hiding them erased the
    // very thing the view is about.
    ...graphOptions(view),
    ...(filterTagIds.length > 0
      ? { centerTagIds: filterTagIds, centerTags, chainTags: [...chainTagById.values()] }
      : {}),
    // The knowledge graph (query mode) fans tags out from a fixed
    // workspace hub. `buildGraphPayload` only activates this when mode
    // resolves to "query" — centered views keep their existing behavior.
    workspace: {
      id: storage.workspace.id,
      name: storage.workspace.name,
      slug: storage.workspace.slug,
      metadata: storage.workspace.metadata,
    },
    tagRelations,
  };
  // Storage is workspace-bound, but fail closed if an adapter ever returns a
  // foreign summary. Tag hubs inherit this same RLS-safe candidate set.
  return buildGraphPayload(
    workspaceNodes,
    edges,
    result.node_ids,
    config,
  );
}

function currentTagIdsByToken(
  tokens: readonly string[],
  nodes: Awaited<ReturnType<Storage["listNodes"]>>,
  resultNodeIds: readonly string[],
): Map<string, string> {
  const wanted = new Set(tokens.map((token) => token.toLocaleLowerCase("en-US")));
  const resultIds = new Set(resultNodeIds);
  const resolved = new Map<string, string>();
  for (const node of nodes) {
    if (!resultIds.has(node.id)) continue;
    for (const tag of node.tags) {
      const identities = [tag.id, tag.slug, tag.normalized_name]
        .map((value) => value.toLocaleLowerCase("en-US"));
      for (const identity of identities) {
        if (wanted.has(identity) && !resolved.has(identity)) resolved.set(identity, tag.id);
      }
    }
  }
  return resolved;
}

/**
 * Every tag the view filters by is a center candidate: `tags_all` (each
 * result carries them) and `tags_any` (they partition the result). The
 * model's `pickCenterTags` then promotes the highest-hierarchy one(s) to
 * the actual center; the rest render as regular satellite tags.
 */
export function filterCenterTagTokens(
  query: Pick<ViewQuery, "tags_any" | "tags_all">,
): string[] {
  return [...new Set([
    ...query.tags_all,
    ...query.tags_any,
  ])].sort((a, b) => a.localeCompare(b));
}

export function graphOptions(view: Pick<SavedView, "query" | "presentation">): GraphBuildOptions {
  const raw = view.presentation.layout.graph;
  const config = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : view.presentation.layout;
  const layers = Array.isArray(config.layers)
    ? config.layers.filter(isGraphLayer)
    : undefined;
  const positions = readPositions(config.positions);
  const configuredCenter = typeof config.center_node_id === "string" ? config.center_node_id : null;
  const centerNodeId = configuredCenter ?? view.query.root_node_ids[0] ?? null;
  return {
    mode: config.mode === "query" || config.mode === "centered"
      ? config.mode
      : centerNodeId ? "centered" : "query",
    centerNodeId,
    depth: finiteNumber(config.depth) ?? view.query.traversal?.depth ?? 2,
    ...(layers && layers.length > 0 ? { layers } : {}),
    ...(positions ? { positions } : {}),
  };
}

function isGraphLayer(value: unknown): value is GraphLayer {
  return value === "hierarchy" || value === "taxonomy" || value === "references" || value === "dependencies" || value === "semantic";
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readPositions(value: unknown): Record<string, { x: number; y: number }> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const positions: Record<string, { x: number; y: number }> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const point = raw as Record<string, unknown>;
    if (typeof point.x === "number" && typeof point.y === "number") positions[id] = { x: point.x, y: point.y };
  }
  return Object.keys(positions).length > 0 ? positions : undefined;
}
