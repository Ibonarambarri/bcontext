/**
 * The graph payload behind a view resolved with the `graph` renderer
 * (`GET /api/views/:id/resolve`, `src/lib/graph/view-snapshot.ts`) and the
 * sigma canvas: resources (nodes, tags, clusters), edges per layer (hierarchy,
 * taxonomy, references, dependencies, semantic), the caps in `GRAPH_LIMITS`
 * that keep a large workspace drawable, clustering, and the deterministic
 * layouts (tag hierarchy, filter-centered) so a graph looks the same on
 * every load and for every viewer.
 *
 * Pure over `KnowledgeNode[]` + tags + edges; the API assembles the inputs
 * and the web only positions what it receives. Colours come from the
 * workspace gradient so clusters match the rest of the UI.
 */
import { findForwardLinks } from "../backlinks.js";
import { goalData, isStrategicGoal } from "../goals.js";
import type { NodeEdge } from "../types.js";
import { expandTagIdsWithDescendants } from "../tag-hierarchy.js";
import {
  getNodeTags,
  type GraphResourceType,
  type KnowledgeNode,
  type TagRelation,
  type WorkspaceTag,
} from "../types.js";
import { gradientFor } from "../workspace-gradients.js";
import { oklchToHex } from "./color.js";

export type GraphMode = "query" | "centered";
export type GraphLayer = "hierarchy" | "taxonomy" | "references" | "dependencies" | "semantic";
export type GraphClusterBy = "none" | "kind" | "parent";

export interface GraphClusterPayload {
  criterion: Exclude<GraphClusterBy, "none">;
  key: string;
  label: string;
  member_count: number;
  member_ids: string[];
  members: GraphCanonicalNodePayload[];
}

interface GraphResourceBase {
  id: string;
  title: string;
  tags: string[];
  depth: number;
  x: number;
  y: number;
  /** Explicit override, takes priority over the kind/tag default in presentation.ts. */
  color?: string;
  /** Explicit override, takes priority over the degree-derived size in presentation.ts. */
  size?: number;
  /**
   * Semantic role in the layout. "filter-center" marks the tag(s) a filtered
   * graph view is centered on — renderers emphasize them and the community
   * assignment groups content by co-tags instead of the (uniform) filter tag.
   */
  role?: "filter-center";
}

/** A persisted, addressable knowledge node. */
export interface GraphCanonicalNodePayload extends GraphResourceBase {
  resource_type: Extract<GraphResourceType, "node">;
  kind: KnowledgeNode["kind"];
  status: KnowledgeNode["status"];
  cluster?: never;
}

/** A virtual taxonomy connector. It is not persisted in `nodes`. */
export interface GraphTagPayload extends GraphResourceBase {
  resource_type: Extract<GraphResourceType, "tag">;
  kind: null;
  status: null;
  tag: Pick<WorkspaceTag, "id" | "name" | "slug" | "normalized_name">;
  assignment_count: number;
  cluster?: never;
}

/** A renderer-only aggregate. It is never persisted as a node. */
export interface GraphClusterNodePayload extends GraphResourceBase {
  resource_type: Extract<GraphResourceType, "cluster">;
  kind: null;
  status: null;
  cluster: GraphClusterPayload;
}

export type GraphResourcePayload =
  | GraphCanonicalNodePayload
  | GraphTagPayload
  | GraphClusterNodePayload;

/** Temporary compatibility alias for renderer code that predates schema v2. */
export type GraphNodePayload = GraphResourcePayload;

export interface GraphEdgePayload {
  id: string;
  from: string;
  to: string;
  layer: GraphLayer;
  type: string;
  label: string;
  directed: boolean;
  virtual: boolean;
  score?: number;
  aggregate_count?: number;
}

export interface GraphSnapshot {
  schema_version: 2;
  mode: GraphMode;
  center_node_id: string | null;
  depth: 1 | 2 | 3;
  layers: GraphLayer[];
  enabled_layers: GraphLayer[];
  nodes: GraphNodePayload[];
  edges: GraphEdgePayload[];
  /**
   * User-persisted anchors, plus — in workspace-hub snapshots — the layout's
   * own landmarks: the hub, every tag's hierarchy position and the hub-orbit
   * slots of anchorless content. The renderer treats each entry as
   * `fixed: true` for ForceAtlas2 (dragging still works).
   */
  pinned_positions: Record<string, { x: number; y: number }>;
  /**
   * The immovable workspace-hub landmark, if this snapshot has one — always
   * pinned at (0.5, 0.5) in `pinned_positions`, never draggable, never moved
   * by ForceAtlas2. Distinct from `center_node_id` (a real traversed node in
   * "centered" mode); a snapshot can have at most one of the two.
   *
   * It is the workspace's North Star node id whenever that goal exists —
   * a real, addressable node — and the synthetic `workspace:<uuid>` id only
   * while a workspace still has no North Star. Renderers must treat it as an
   * opaque id and never parse it.
   */
  hub_node_id: string | null;
  /**
   * Filter-centered snapshots only: the palette slot each workspace tag
   * FAMILY (root tag) would get in the unfiltered knowledge graph, keyed by
   * tag resource id. Lets a filtered view keep the exact color its filter
   * tag has as a community in the main graph, no matter how few of that
   * family's members the filter kept visible.
   */
  community_palette?: Record<string, number>;
  counts: {
    visible_nodes: number;
    hidden_nodes: number;
    visible_tags: number;
    hidden_tags: number;
    visible_edges: number;
    hidden_edges: number;
    visible_membership_edges: number;
    hidden_membership_edges: number;
  };
  truncated: boolean;
  limits: { max_nodes: number; max_tags: number; max_edges: number; max_membership_edges: number; max_depth: 3 };
}

/** Minimal workspace identity needed to render the knowledge-graph hub node. */
export interface GraphWorkspaceHub {
  id: string;
  name: string;
  slug: string;
  metadata?: Record<string, unknown> | null;
}

export interface GraphBuildOptions {
  mode?: GraphMode;
  centerNodeId?: string | null;
  depth?: number;
  layers?: GraphLayer[];
  maxNodes?: number;
  maxTags?: number;
  maxEdges?: number;
  maxMembershipEdges?: number;
  /** Optional view-persisted coordinates in normalized 0..1 canvas space. */
  positions?: Record<string, { x: number; y: number }>;
  /** Canonical tag ids already guaranteed by the view query and omitted as redundant hubs. */
  omitTagIds?: readonly string[];
  /**
   * Canonical tag ids the view is filtered by. In query mode the graph is
   * re-rooted on them: `pickCenterTags` chooses the highest-hierarchy tag(s)
   * as the center (co-centers when tied, connected to each other), only tags
   * carried by the filtered result render, and the workspace hub is omitted
   * entirely. Takes precedence over `workspace` when non-empty.
   */
  centerTagIds?: readonly string[];
  /**
   * Descriptors for the filter tags, so a filter that only matches through
   * descendants (e.g. filtering by a parent tag none of the result nodes
   * carry directly) can still render its tag as the center hub.
   */
  centerTags?: ReadonlyArray<Pick<WorkspaceTag, "id" | "name" | "slug" | "normalized_name">>;
  /**
   * Descriptors for every tag on the filter chain (the filter tag(s) plus
   * all their descendants). A filtered view always renders the filter's
   * complete subtree — a child with no assigned nodes in the result still
   * appears, connected to its parent, so the hierarchy under the filter
   * stays legible. Without a descriptor an absent descendant is skipped.
   */
  chainTags?: ReadonlyArray<Pick<WorkspaceTag, "id" | "name" | "slug" | "normalized_name">>;
  /** Global query results are clustered before the render hard cap is applied. */
  clusterBy?: GraphClusterBy;
  /**
   * When supplied (and `mode` resolves to "query"), the snapshot gains a
   * fixed workspace hub node and root tags/tag-tree fan out from it — see
   * `buildTagHierarchyLayout`. Omitted entirely, the payload is identical to
   * pre-Fase-2 behavior.
   */
  workspace?: GraphWorkspaceHub;
  /** Tag parent/related edges — required to compute hierarchy depth and layout. */
  tagRelations?: readonly TagRelation[];
}

export const GRAPH_LIMITS = {
  maxNodes: 80,
  maxTags: 32,
  maxEdges: 240,
  maxMembershipEdges: 320,
  maxDepth: 3,
  maxSemanticEdges: 40,
  maxSemanticCandidates: 120,
} as const;

const ALL_LAYERS: GraphLayer[] = ["hierarchy", "taxonomy", "references", "dependencies", "semantic"];
const DEFAULT_LAYERS: GraphLayer[] = ["hierarchy", "taxonomy", "references", "dependencies"];

/** Radial rings are capped so a deep/cyclic tag tree cannot grow off-canvas. */
const MAX_TAG_HIERARCHY_DEPTH = 6;
/** ~2.7x a low-degree tag hub (3.8) and clearly above the largest content node (~10) — "it's the center" at a glance. */
const WORKSPACE_HUB_SIZE = 12;

/**
 * The strategy ring: company-scope goals orbit the center INSIDE the tag
 * rings. The order is the argument. "What do we want" is read before "what do
 * we talk about", so the ring that answers it sits closer to the center and
 * its glyphs are bigger than any tag hub. Three to five goals is the expected
 * population, so an evenly divided circle is enough — the mass-proportional
 * wedges the tag tree needs would only add noise at that count.
 */
const GOAL_RING_RADIUS = 0.18;
/** Above every tag hub (a root tag tops out at ~6.4) and clearly under the center (12). */
const GOAL_RING_SIZE = 9;

/**
 * Tag ring geometry, in two flavors. Normally the first ring starts at 0.16,
 * just outside the hub-orbit band where untagged content seeds (max 0.125).
 * When the strategy ring is occupied the tags have to clear it instead, so
 * they start at 0.35 — and because the canvas ceiling is fixed (`clampPoint`
 * caps every point at 0.46 from the center) the deeper rings pay for that
 * clearance with a tighter step. That is the right trade: depth >= 3 already
 * collapsed onto the outermost ring before this change, while "a goal is not
 * a tag" is the one distinction a reader must never miss. With no company
 * goals the geometry is identical to pre-goal snapshots, on purpose.
 */
const TAG_RINGS = { base: 0.16, step: 0.12, max: 0.44 } as const;
const TAG_RINGS_WITH_GOAL_RING = { base: 0.35, step: 0.05, max: 0.46 } as const;

/** Filter-center tags read as "the root of this view" — just under the workspace hub (12). */
const FILTER_CENTER_SIZE = 10.5;
/** Co-centers (tied hierarchy) sit on a small ring around the canvas center. */
const CO_CENTER_RING_RADIUS = 0.085;

const TAG_HIERARCHY_BASE_SIZE = 3.8;
/** Root tags read as clearly more important than deep ones; depth 3+ all share the floor size. */
const TAG_HIERARCHY_DEPTH_MULTIPLIER: Record<number, number> = { 1: 1.6, 2: 1.2 };

/**
 * Tag size for the tags graph (`tags-graph-view.tsx`): dominated by
 * hierarchy depth (root tags read as clearly bigger than deep ones,
 * matching the workspace hub reading as bigger than every tag), with
 * `ownAssignmentCount` only a fine-tune *within* the same depth tier — the
 * per-tier gap (0.76–1.52) is kept well above the max fine-adjust (0.3) so
 * usage can never make a deeper tag outsize a shallower one.
 */
export function tagHierarchySize(depth: number, ownAssignmentCount: number, maxAssignmentCountAtDepth: number): number {
  const multiplier = TAG_HIERARCHY_DEPTH_MULTIPLIER[depth] ?? 1;
  const fineAdjust = maxAssignmentCountAtDepth > 0
    ? (Math.log1p(Math.max(0, ownAssignmentCount)) / Math.log1p(maxAssignmentCountAtDepth)) * 0.3
    : 0;
  return TAG_HIERARCHY_BASE_SIZE * multiplier + fineAdjust;
}

/**
 * Build the complete payload consumed by graph renderers. The caller supplies
 * canonical query-result ids, one batch of nodes and one batch of durable
 * edges; the renderer never resolves nodes one by one and never hides part of
 * an already-resolved result behind a second presentation cap.
 *
 * Semantic links are calculated in memory and marked virtual. They are never
 * written to Storage. The lightweight token projection makes demo/offline
 * workspaces useful while keeping the boundary ready for embedding-derived
 * candidates supplied by a future resolver.
 */
export function buildGraphPayload(
  nodes: KnowledgeNode[],
  durableEdges: NodeEdge[],
  resultNodeIds: readonly string[],
  options: GraphBuildOptions = {},
): GraphSnapshot {
  const depth = clampInt(options.depth ?? 2, 1, GRAPH_LIMITS.maxDepth) as 1 | 2 | 3;
  // Keep the legacy limits in the wire shape while saved views migrate, but
  // do not apply them here. Query traversal is the sole scope boundary; once
  // a node is resolved, Graph always represents it.
  const maxNodes = finitePositiveInt(options.maxNodes, GRAPH_LIMITS.maxNodes);
  const maxTags = finitePositiveInt(options.maxTags, GRAPH_LIMITS.maxTags);
  const maxEdges = finitePositiveInt(options.maxEdges, GRAPH_LIMITS.maxEdges);
  const maxMembershipEdges = finitePositiveInt(options.maxMembershipEdges, GRAPH_LIMITS.maxMembershipEdges);
  const enabledLayers = uniqueLayers(options.layers ?? DEFAULT_LAYERS);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const candidateIds = [...new Set(resultNodeIds)].filter((id) => byId.has(id)).sort();
  const candidateSet = new Set(candidateIds);
  const requestedCenter = options.centerNodeId && candidateSet.has(options.centerNodeId)
    ? options.centerNodeId
    : null;
  const mode: GraphMode = options.mode ?? (requestedCenter ? "centered" : "query");
  const centerNodeId = mode === "centered" ? (requestedCenter ?? candidateIds[0] ?? null) : null;

  // The strategy layer only exists under the workspace hub. "centered" mode
  // already has a real, meaningful center (the viewed node) and a filtered
  // view is re-rooted on its filter tag; silently re-centering either of them
  // on a goal would answer a question the user did not ask.
  const hubModeRequested = mode === "query"
    && Boolean(options.workspace)
    && (options.centerTagIds ?? []).length === 0;
  const northStar = hubModeRequested ? findNorthStar(nodes) : null;
  const companyGoals = hubModeRequested
    ? nodes.filter((node) =>
      candidateSet.has(node.id)
      && isStrategicGoal(node)
      && goalData(node).root !== true
      && node.status !== "archived")
    : [];
  // The North Star is a landmark, not a query result: like the synthetic hub
  // it renders even when the current result set left it out. The
  // `contributes_to` arrows aimed at it have to survive that asymmetry — a
  // node the layout draws is a node an edge may reach — so it joins the
  // endpoint set used to build (and later to filter) edges.
  const edgeCandidateSet = northStar && !candidateSet.has(northStar.id)
    ? new Set([...candidateSet, northStar.id])
    : candidateSet;
  // Ship every bounded layer in one snapshot so toggles never trigger a
  // per-node refetch. `enabled_layers` controls the initial presentation.
  const nodeEdges = buildLayerEdges(nodes, durableEdges, edgeCandidateSet, ALL_LAYERS);
  const taxonomy = buildTaxonomyResources(nodes, candidateSet);
  const allEdges = [...nodeEdges, ...taxonomy.edges].sort((a, b) => a.id.localeCompare(b.id));
  const omittedTagResourceIds = new Set((options.omitTagIds ?? []).map((id) =>
    id.startsWith("tag:") ? id : `tag:${id}`,
  ));
  const depthById = mode === "centered" && centerNodeId
    // Include the full allowed 3-hop neighborhood once; the renderer can
    // move between depth 1–3 without another request.
    ? traverseDepths(centerNodeId, allEdges, GRAPH_LIMITS.maxDepth)
    : new Map([...candidateIds, ...taxonomy.tags.map((tag) => tag.id)].map((id) => [id, 0]));
  const eligibleIds = candidateIds.filter((id) => depthById.has(id));
  const orderedIds = mode === "centered"
    ? eligibleIds.sort((a, b) => (depthById.get(a)! - depthById.get(b)!) || a.localeCompare(b))
    : eligibleIds;
  const sourceNodes = orderedIds.map((id): GraphCanonicalNodePayload => {
    const node = byId.get(id)!;
    return {
      resource_type: "node",
      id,
      title: node.title,
      kind: node.kind,
      status: node.status,
      tags: getNodeTags(node),
      depth: depthById.get(id) ?? 0,
      x: 0,
      y: 0,
    };
  });
  const eligibleTagResources = taxonomy.tags
    .filter((tag) => depthById.has(tag.id) && !omittedTagResourceIds.has(tag.id))
    .map((tag) => ({ ...tag, depth: depthById.get(tag.id) ?? 0 }));
  const visibleContent: GraphResourcePayload[] = sourceNodes;
  const contentSet = new Set(visibleContent.map((node) => node.id));
  const edgeEndpointSet = northStar && !contentSet.has(northStar.id)
    ? new Set([...contentSet, northStar.id])
    : contentSet;
  const visibleNodeEdges = allEdges.filter((edge) =>
    edge.layer !== "taxonomy" && edgeEndpointSet.has(edge.from) && edgeEndpointSet.has(edge.to),
  );
  const eligibleTagIds = new Set(eligibleTagResources.map((tag) => tag.id));
  const eligibleMemberships = allEdges.filter((edge) => {
    if (edge.layer !== "taxonomy") return false;
    const tagId = edge.from.startsWith("tag:") ? edge.from : edge.to;
    const contentId = edge.from === tagId ? edge.to : edge.from;
    return contentSet.has(contentId) && eligibleTagIds.has(tagId);
  });
  const membershipCountByTag = new Map<string, number>();
  for (const edge of eligibleMemberships) {
    const tagId = edge.from.startsWith("tag:") ? edge.from : edge.to;
    membershipCountByTag.set(tagId, (membershipCountByTag.get(tagId) ?? 0) + (edge.aggregate_count ?? 1));
  }
  // Filter-centered layout (custom graph views): when the view is filtered
  // by tags, those tags — not the workspace — are the semantic root. The
  // highest-hierarchy filter tag(s) become the pinned center; everything
  // else hangs off them. Takes precedence over the workspace hub.
  const requestedCenterIds = mode === "query"
    ? [...new Set((options.centerTagIds ?? []).map((id) => (id.startsWith("tag:") ? id.slice(4) : id)))]
    : [];
  // A filtered view renders ONLY the filter chain: the filter tag(s) plus
  // their complete descendant subtree (the same inheritance that admits
  // result nodes). Co-tags outside that chain — siblings of the filter,
  // unfiltered ancestors, foreign branches — never become hubs: result nodes
  // in a real workspace collectively carry most of the taxonomy, so
  // rendering every co-tag re-drew the entire workspace tag tree around
  // every filtered view. Their memberships drop with them; the nodes stay
  // and anchor on the chain.
  const filterChainTagIds = requestedCenterIds.length > 0
    ? expandTagIdsWithDescendants(requestedCenterIds, options.tagRelations ?? [])
    : null;
  const visibleTags = eligibleTagResources
    .filter((tag) => membershipCountByTag.has(tag.id))
    .filter((tag) => filterChainTagIds === null || filterChainTagIds.has(tag.tag.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const visibleTagIds = new Set(visibleTags.map((tag) => tag.id));
  const visibleMemberships = eligibleMemberships.filter((edge) =>
    visibleTagIds.has(edge.from.startsWith("tag:") ? edge.from : edge.to),
  );
  const visibleTagIdSet = new Set(visibleTags.map((tag) => tag.id));
  // A filter tag matched only through its descendants has no direct
  // memberships in the result, so `buildTaxonomyResources` never emitted
  // it — synthesize its hub from the caller-provided descriptor so the
  // center of the view is never invisible.
  const centerDescriptorById = new Map((options.centerTags ?? []).map((tag) => [tag.id, tag]));
  const syntheticCenterTags: GraphTagPayload[] = requestedCenterIds
    .filter((id) => !visibleTagIdSet.has(`tag:${id}`) && centerDescriptorById.has(id))
    .map((id): GraphTagPayload => {
      const descriptor = centerDescriptorById.get(id)!;
      return {
        resource_type: "tag",
        id: `tag:${id}`,
        title: `#${descriptor.name}`,
        kind: null,
        status: null,
        tags: [],
        tag: { id, name: descriptor.name, slug: descriptor.slug, normalized_name: descriptor.normalized_name },
        assignment_count: 0,
        depth: 1,
        x: 0.5,
        y: 0.5,
      };
    });
  // The filter's subtree is never pruned by usage: a descendant tag with no
  // assigned nodes in the result still renders (as an empty satellite hooked
  // to its parent) so the hierarchy UNDER the filter stays complete. Only
  // tags at the filter's altitude — siblings and foreign branches — are cut.
  const chainDescriptorById = new Map((options.chainTags ?? []).map((tag) => [tag.id, tag]));
  const requestedCenterIdSet = new Set(requestedCenterIds);
  const syntheticChainTags: GraphTagPayload[] = filterChainTagIds
    ? [...filterChainTagIds]
      .filter((id) =>
        !requestedCenterIdSet.has(id)
        && !visibleTagIdSet.has(`tag:${id}`)
        && chainDescriptorById.has(id))
      .sort()
      .map((id): GraphTagPayload => {
        const descriptor = chainDescriptorById.get(id)!;
        return {
          resource_type: "tag",
          id: `tag:${id}`,
          title: `#${descriptor.name}`,
          kind: null,
          status: null,
          tags: [],
          tag: { id, name: descriptor.name, slug: descriptor.slug, normalized_name: descriptor.normalized_name },
          assignment_count: 0,
          depth: 1,
          x: 0.5,
          y: 0.5,
        };
      })
    : [];
  const layoutTags = syntheticCenterTags.length + syntheticChainTags.length > 0
    ? [...visibleTags, ...syntheticCenterTags, ...syntheticChainTags].sort((a, b) => a.id.localeCompare(b.id))
    : visibleTags;
  const layoutTagIdSet = new Set(layoutTags.map((tag) => tag.id));
  const centerCandidates = requestedCenterIds
    .map((id) => `tag:${id}`)
    .filter((id) => layoutTagIdSet.has(id));
  const filterLayout = centerCandidates.length > 0
    ? buildFilterCenteredLayout(
      pickCenterTags(
        centerCandidates.map((id) => id.slice(4)),
        options.tagRelations ?? [],
        new Map(layoutTags.map((tag) => [tag.tag.id, tag.assignment_count])),
      ).map((id) => `tag:${id}`),
      layoutTags,
      options.tagRelations ?? [],
    )
    : null;
  // The workspace hub + tag-first radial layout is Fase 2's knowledge-graph
  // ordering. It only replaces the plain query-mode layout: "centered" mode
  // already has a real, meaningful center (the viewed node) and is left
  // untouched, and omitting `options.workspace` reproduces the exact
  // pre-Fase-2 payload for every existing caller/test.
  const hub = !filterLayout && mode === "query" && options.workspace
    ? buildTagHierarchyLayout(options.workspace, visibleTags, options.tagRelations ?? [], {
      northStar,
      companyGoals,
    })
    : null;
  const centerResourceIds = new Set(filterLayout?.centerResourceIds ?? []);
  const finalTags = filterLayout
    ? layoutTags.map((tag) => centerResourceIds.has(tag.id)
      ? { ...tag, depth: 0, size: FILTER_CENTER_SIZE, role: "filter-center" as const }
      : { ...tag, depth: filterLayout.tagDepths.get(tag.id) ?? tag.depth })
    : hub
      ? visibleTags.map((tag) => ({ ...tag, depth: hub.tagDepths.get(tag.id) ?? tag.depth }))
      : visibleTags;
  const visibleUnpositioned: GraphResourcePayload[] = [...visibleContent, ...finalTags];
  // The center only needs a payload of its own when nothing in the content
  // lane already carries its id: the synthetic hub (never a row) always does,
  // a North Star the query happened to return never does — it stays where it
  // is and is merely promoted, so its counts, tags and status stay honest.
  // `kind: "entity"` on the synthetic hub is still just what makes the
  // payload type; the North Star branch reports the real kind.
  const centerNode: GraphCanonicalNodePayload | null = hub && !contentSet.has(hub.centerId) ? {
    resource_type: "node",
    id: hub.centerId,
    title: northStar ? northStar.title : options.workspace!.name,
    kind: northStar ? northStar.kind : "entity",
    status: northStar ? northStar.status : null,
    tags: northStar ? getNodeTags(northStar) : [],
    depth: 0,
    x: hub.centerPosition.x,
    y: hub.centerPosition.y,
    color: hub.centerColor,
    size: WORKSPACE_HUB_SIZE,
  } : null;
  const anchorTagIds = filterLayout
    ? new Set(finalTags.flatMap((tag) => (centerResourceIds.has(tag.id) ? [] : [tag.id])))
    : new Set(finalTags.map((tag) => tag.id));
  // Orbit anchors: in filter-centered mode a node's anchor prefers its
  // co-tags — every result node carries the filter tag, so anchoring on it
  // would collapse the view into one uniform flower. Co-tags articulate the
  // internal structure; the center remains the fallback anchor.
  const primaryTagByNode = (filterLayout || hub)
    ? primaryTagResourceByNode(nodes, candidateSet, anchorTagIds)
    : new Map<string, string>();
  if (filterLayout) {
    const centerByNode = primaryTagResourceByNode(nodes, candidateSet, centerResourceIds);
    for (const id of visibleContent.map((node) => node.id)) {
      if (!primaryTagByNode.has(id)) {
        primaryTagByNode.set(id, centerByNode.get(id) ?? filterLayout.centerResourceIds[0]!);
      }
    }
  }
  if (hub) {
    // The center and the strategy ring are pinned landmarks, so they anchor
    // themselves. Registering that is what stops a component hanging off a
    // goal from reading as anchorless and being pinned into the hub orbit,
    // right on top of the ring it actually belongs to. It also enforces the
    // scope rule at layout level: a company goal that carries a tag is never
    // pulled out of the center by it.
    if (contentSet.has(hub.centerId)) primaryTagByNode.set(hub.centerId, hub.centerId);
    for (const goalId of hub.goalPositions.keys()) primaryTagByNode.set(goalId, goalId);
    // `contributes_to` is the only relation that says "this work pushes that
    // objective", and unlike `parent_id` it admits N targets. A node with no
    // tag of its own therefore belongs, visually, to the goal it pushes:
    // it orbits that goal instead of the hub. The first target by edge id
    // wins the orbit (stable across rebuilds); the rest stay visible as
    // arrows in the dependencies layer, which is where the N:N actually
    // lives — a single seed position could never express it.
    for (const edge of visibleNodeEdges) {
      if (edge.type !== "contributes_to" || primaryTagByNode.has(edge.from)) continue;
      if (edge.to === hub.centerId || hub.goalPositions.has(edge.to)) {
        primaryTagByNode.set(edge.from, edge.to);
      }
    }
  }
  // Content whose whole connected component holds no tag anchor gives
  // ForceAtlas2 nothing to attract it — only gravity toward the canvas
  // center, which historically collapsed dozens of nodes into an unreadable
  // pile on top of the workspace hub. Those nodes get pinned hub-orbit slots.
  const anchorlessIds = hub
    ? anchorlessContentIds(visibleContent.map((node) => node.id), visibleNodeEdges, primaryTagByNode)
    : new Set<string>();
  const positions = filterLayout
    ? filterCenteredPositions(filterLayout, sourceNodes, primaryTagByNode, options.positions)
    : hub
      ? knowledgeHubPositions(hub, sourceNodes, primaryTagByNode, options.positions)
      : deterministicLayout(
        visibleUnpositioned.map((node) => ({ id: node.id, depth: node.depth })),
        mode,
        centerNodeId,
        options.positions,
      );
  const positionedTagsAndContent = visibleUnpositioned
    .map((node) => ({ ...node, ...positions.get(node.id)! }))
    .map((node) => promoteStrategyNode(node, hub));
  const payloadNodes: GraphNodePayload[] = centerNode
    ? [{ ...centerNode, ...positions.get(centerNode.id)! }, ...positionedTagsAndContent]
    : positionedTagsAndContent;
  const singleFilterCenter = filterLayout && filterLayout.centerResourceIds.length === 1
    ? filterLayout.centerResourceIds[0]!
    : null;
  const pinnedPositions: Record<string, { x: number; y: number }> = {};
  for (const node of payloadNodes) {
    // The workspace hub — or a single filter-center tag — is a fixed
    // landmark: exactly (0.5, 0.5), always. No saved drag, no ForceAtlas2
    // settle, ever overrides it. Everything else keeps the normal
    // precedence (persisted drag wins over computed).
    if (hub && node.id === hub.centerId) {
      pinnedPositions[node.id] = hub.centerPosition;
      continue;
    }
    if (singleFilterCenter && node.id === singleFilterCenter) {
      pinnedPositions[node.id] = { x: 0.5, y: 0.5 };
      continue;
    }
    const persisted = persistedPoint(options.positions?.[node.id]);
    if (persisted) {
      pinnedPositions[node.id] = persisted;
      continue;
    }
    // Tags are always fixed at their computed hierarchy position — only
    // content nodes settle via the renderer's ForceAtlas2 pass (which reads
    // `fixed: Boolean(persisted)` off pinned_positions).
    if ((hub || filterLayout) && node.resource_type === "tag") {
      pinnedPositions[node.id] = { x: node.x, y: node.y };
      continue;
    }
    // Company goals are fixed geometry too: the strategy ring is a landmark
    // the reader navigates by, and a force pass that drifted it would erase
    // the very hierarchy (goals inside, tags outside) the ring encodes.
    if (hub && hub.goalPositions.has(node.id)) {
      pinnedPositions[node.id] = { x: node.x, y: node.y };
      continue;
    }
    // Anchorless content is pinned on its hub-orbit slot: free, it either
    // sinks onto the hub (gravity) or gets flung to the periphery
    // (repulsion) — both destroy the "belongs to the workspace" reading.
    if (hub && node.resource_type === "node" && anchorlessIds.has(node.id)) {
      pinnedPositions[node.id] = { x: node.x, y: node.y };
    }
  }
  const representedMemberships = relationCount(visibleMemberships);
  // A company goal that is ALSO a real child of the North Star (`parent_id`,
  // or a durable `contributes_to`) would otherwise get two arrows for one
  // fact. The persisted edge wins; the synthetic anchor only fills the gap.
  const realNodePairs = new Set(visibleNodeEdges.flatMap((edge) => [
    `${edge.from}|${edge.to}`,
    `${edge.to}|${edge.from}`,
  ]));
  const hubEdges = (hub?.edges ?? []).filter((edge) =>
    edge.type !== "goal-scope" || !realNodePairs.has(`${edge.from}|${edge.to}`),
  );
  const visibleEdges = [
    ...visibleNodeEdges,
    ...visibleMemberships,
    ...hubEdges,
    ...(filterLayout?.edges ?? []),
  ].sort((a, b) => a.id.localeCompare(b.id));

  return {
    schema_version: 2,
    mode,
    center_node_id: centerNodeId,
    depth,
    layers: ALL_LAYERS,
    enabled_layers: enabledLayers,
    nodes: payloadNodes,
    edges: visibleEdges,
    pinned_positions: pinnedPositions,
    hub_node_id: hub?.centerId ?? singleFilterCenter,
    ...(filterLayout
      ? { community_palette: workspaceCommunityPaletteSlots(nodes, options.tagRelations ?? []) }
      : {}),
    counts: {
      visible_nodes: visibleContent.length,
      hidden_nodes: 0,
      visible_tags: finalTags.length,
      hidden_tags: 0,
      visible_edges: visibleNodeEdges.length + hubEdges.length,
      hidden_edges: 0,
      visible_membership_edges: representedMemberships,
      hidden_membership_edges: 0,
    },
    truncated: false,
    limits: {
      max_nodes: maxNodes,
      max_tags: maxTags,
      max_edges: maxEdges,
      max_membership_edges: maxMembershipEdges,
      max_depth: 3,
    },
  };
}

/** Collapse a complete query result into deterministic global groups before caps. */
export function clusterGraph(
  sourceNodes: GraphCanonicalNodePayload[],
  sourceEdges: GraphEdgePayload[],
  canonicalNodes: KnowledgeNode[],
  criterion: Exclude<GraphClusterBy, "none">,
): { nodes: GraphNodePayload[]; edges: GraphEdgePayload[] } {
  const canonical = new Map(canonicalNodes.map((node) => [node.id, node]));
  const groups = new Map<string, GraphCanonicalNodePayload[]>();
  const groupFor = (node: GraphCanonicalNodePayload): { key: string; label: string } => {
    if (criterion === "kind") return { key: node.kind, label: node.kind };
    const parentId = canonical.get(node.id)?.parent_id ?? "root";
    return { key: parentId, label: parentId === "root" ? "Root nodes" : canonical.get(parentId)?.title ?? "Parent unavailable" };
  };
  const labels = new Map<string, string>();
  for (const node of sourceNodes) {
    const group = groupFor(node);
    labels.set(group.key, group.label);
    const members = groups.get(group.key) ?? [];
    members.push(node);
    groups.set(group.key, members);
  }
  const memberToCluster = new Map<string, string>();
  const nodes = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, members]): GraphClusterNodePayload => {
    members.sort((a, b) => a.id.localeCompare(b.id));
    const id = `cluster:${criterion}:${encodeURIComponent(key)}`;
    for (const member of members) memberToCluster.set(member.id, id);
    return {
      resource_type: "cluster",
      id,
      title: `${labels.get(key) ?? key} (${members.length})`,
      kind: null,
      status: null,
      tags: [],
      depth: 0,
      x: 0,
      y: 0,
      cluster: {
        criterion,
        key,
        label: labels.get(key) ?? key,
        member_count: members.length,
        member_ids: members.map((member) => member.id),
        members,
      },
    };
  });
  const aggregated = new Map<string, GraphEdgePayload & { count: number }>();
  for (const edge of sourceEdges) {
    const from = memberToCluster.get(edge.from) ?? edge.from;
    const to = memberToCluster.get(edge.to) ?? edge.to;
    if (from === to) continue;
    const mapsContent = memberToCluster.has(edge.from) || memberToCluster.has(edge.to);
    if (!mapsContent) continue;
    const id = `cluster-edge:${edge.layer}:${from}>${to}`;
    const current = aggregated.get(id);
    if (current) current.count += 1;
    else aggregated.set(id, { ...edge, id, from, to, label: edge.label, count: 1 });
  }
  const edges = [...aggregated.values()].sort((a, b) => a.id.localeCompare(b.id)).map(({ count, ...edge }) => ({
    ...edge,
    label: count > 1 ? `${count} ${edge.layer} links` : edge.label,
    aggregate_count: count,
  }));
  return { nodes, edges };
}

export function expandGraphClusters(
  nodes: GraphNodePayload[],
  expandedClusterIds: ReadonlySet<string>,
  maxNodes = GRAPH_LIMITS.maxNodes,
): { nodes: GraphNodePayload[]; hidden_members: number } {
  const output: GraphNodePayload[] = [];
  let hiddenMembers = 0;
  for (const node of nodes) {
    if (output.length >= maxNodes) {
      hiddenMembers += node.cluster?.member_count ?? 1;
      continue;
    }
    output.push(node);
    if (!node.cluster) continue;
    if (!expandedClusterIds.has(node.id)) {
      hiddenMembers += node.cluster.member_count;
      continue;
    }
    const available = Math.max(0, maxNodes - output.length);
    const members = node.cluster.members.slice(0, available).map((member, index, all) => {
      const angle = stableUnit(member.id, "cluster-angle") * Math.PI * 2;
      const ring = 0.055 + Math.floor(index / Math.max(8, Math.ceil(Math.sqrt(all.length)))) * 0.035;
      return {
        ...member,
        x: Math.max(0.04, Math.min(0.96, node.x + Math.cos(angle) * ring)),
        y: Math.max(0.04, Math.min(0.96, node.y + Math.sin(angle) * ring)),
      };
    });
    output.push(...members);
    hiddenMembers += node.cluster.member_count - members.length;
  }
  return { nodes: output, hidden_members: hiddenMembers };
}

/** Build virtual tag hubs and one virtual membership edge per active assignment. */
export function buildTaxonomyResources(
  nodes: KnowledgeNode[],
  candidates: ReadonlySet<string>,
): { tags: GraphTagPayload[]; edges: GraphEdgePayload[] } {
  const tagById = new Map<string, WorkspaceTag>();
  const assignments = new Map<string, Set<string>>();
  for (const node of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!candidates.has(node.id)) continue;
    const seen = new Set<string>();
    for (const tag of [...node.tags].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!tag.id || tag.deleted_at || tag.merged_into_id || seen.has(tag.id)) continue;
      seen.add(tag.id);
      tagById.set(tag.id, tag);
      const members = assignments.get(tag.id) ?? new Set<string>();
      members.add(node.id);
      assignments.set(tag.id, members);
    }
  }
  const tags = [...tagById.values()].sort((a, b) => a.id.localeCompare(b.id)).map((tag): GraphTagPayload => ({
    resource_type: "tag",
    id: `tag:${tag.id}`,
    title: `#${tag.name}`,
    kind: null,
    status: null,
    tags: [],
    tag: { id: tag.id, name: tag.name, slug: tag.slug, normalized_name: tag.normalized_name },
    assignment_count: assignments.get(tag.id)?.size ?? 0,
    depth: 0,
    x: 0,
    y: 0,
  }));
  const edges = tags.flatMap((tag) => [...(assignments.get(tag.tag.id) ?? [])].sort().map((nodeId): GraphEdgePayload => ({
    id: `taxonomy:${tag.tag.id}>${nodeId}`,
    from: tag.id,
    to: nodeId,
    layer: "taxonomy",
    type: "tag_membership",
    label: "tagged",
    directed: false,
    virtual: true,
  })));
  return { tags, edges };
}

interface TagHierarchyLayout {
  centerId: string;
  centerPosition: { x: number; y: number };
  centerColor: string;
  /** Identity color of the strategy ring — the other end of the workspace gradient. */
  goalColor: string;
  /** Keyed by NODE id — company-scope goals pinned on the strategy ring. */
  goalPositions: Map<string, { x: number; y: number }>;
  /** Keyed by tag resource id (`tag:<id>`). */
  tagPositions: Map<string, { x: number; y: number }>;
  /** Keyed by tag resource id — the hierarchy depth (1 = root), not traversal depth. */
  tagDepths: Map<string, number>;
  edges: GraphEdgePayload[];
}

/**
 * The strategy layer of a workspace-hub snapshot: what the workspace wants,
 * as opposed to what it talks about (tags) or what it holds (content).
 */
export interface GraphStrategyLayer {
  /**
   * The workspace's North Star — the real `goal` row carrying
   * `data.root === true`. When it exists it REPLACES the synthetic
   * `workspace:<uuid>` hub as the center, so the middle of the graph becomes
   * an addressable, clickable node that opens the mission instead of a
   * decoration nothing can link to.
   */
  northStar?: KnowledgeNode | null;
  /** Company-scope goals (never the North Star) to place on the strategy ring. */
  companyGoals?: readonly KnowledgeNode[];
}

/**
 * Tag-first radial layout for the knowledge graph (Fase 2). Depth is the
 * shortest parent-chain distance to a root tag (multi-parent tags use the
 * minimum), computed with a cycle-safe multi-source BFS. Siblings land
 * contiguously by giving each tag an angular span proportional to its
 * subtree's leaf count, recursively subdivided — a standard radial tidy-tree
 * layout. Root tags (or tags whose only parents are cyclic/unreachable) hang
 * directly off the workspace hub, exactly like `tags-graph-view.tsx`.
 */
export function buildTagHierarchyLayout(
  workspace: GraphWorkspaceHub,
  visibleTags: GraphTagPayload[],
  relations: readonly TagRelation[],
  strategy: GraphStrategyLayer = {},
): TagHierarchyLayout {
  // Two centers, one contract. With a North Star the center is that node's
  // real id; without one the synthetic `workspace:<uuid>` hub is fabricated
  // exactly as before. The fallback is not laziness: it is what keeps the
  // graph from having a broken window while the backfill walks the older
  // workspaces one by one.
  const northStar = strategy.northStar ?? null;
  const centerId = northStar ? northStar.id : `workspace:${workspace.id}`;
  const centerPosition = { x: 0.5, y: 0.5 };
  // Sigma's WebGL parser only accepts legacy CSS colors; the gradient tokens
  // are OKLCH and would silently render as opaque black without conversion.
  const gradient = gradientFor({ slug: workspace.slug, metadata: workspace.metadata });
  // The North Star keeps the WORKSPACE gradient rather than taking the color
  // of kind `goal`: on the day the backfill lands, the graph must look like
  // the graph people already know. Only the identity of the center changes,
  // never its appearance.
  const centerColor = oklchToHex(gradient.from);
  // The strategy ring takes the other end of the same gradient: goals are
  // workspace identity, not one more topic. One family at the center, the
  // community palette outside it.
  const goalColor = oklchToHex(gradient.to);
  const companyGoals = [...(strategy.companyGoals ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  const goalPositions = new Map<string, { x: number; y: number }>();
  companyGoals.forEach((goal, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / companyGoals.length;
    goalPositions.set(goal.id, clampPoint({
      x: centerPosition.x + Math.cos(angle) * GOAL_RING_RADIUS,
      y: centerPosition.y + Math.sin(angle) * GOAL_RING_RADIUS,
    }));
  });
  const visibleTagIds = new Set(visibleTags.map((tag) => tag.tag.id));

  const { depthById, primaryParentById } = computeTagDepths(relations, visibleTagIds);
  const tagDepths = new Map(visibleTags.map((tag) => [tag.id, Math.min(MAX_TAG_HIERARCHY_DEPTH, depthById.get(tag.tag.id) ?? 1)]));

  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const id of depthById.keys()) {
    const parent = primaryParentById.get(id);
    if (parent) childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), id].sort());
    else roots.push(id);
  }
  roots.sort();
  // Weight = this tag's own assigned nodes + the recursive weight of its
  // descendants — a wedge's angular width is genuinely proportional to how
  // much of the workspace lives under it, not just its raw child count.
  const massById = new Map(visibleTags.map((tag) => [tag.tag.id, Math.max(1, tag.assignment_count)]));
  const angleById = assignSubtreeAngles(roots, childrenOf, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2, massById);

  const rings = goalPositions.size > 0 ? TAG_RINGS_WITH_GOAL_RING : TAG_RINGS;
  const tagPositions = new Map<string, { x: number; y: number }>();
  for (const tag of visibleTags) {
    const depth = tagDepths.get(tag.id)!;
    const angle = angleById.get(tag.tag.id) ?? 0;
    const radius = Math.min(rings.max, rings.base + (depth - 1) * rings.step);
    tagPositions.set(tag.id, clampPoint({
      x: centerPosition.x + Math.cos(angle) * radius,
      y: centerPosition.y + Math.sin(angle) * radius,
    }));
  }

  const edges: GraphEdgePayload[] = [];
  for (const tag of visibleTags) {
    const ancestor = nearestRenderedAncestor(tag.tag.id, primaryParentById, visibleTagIds);
    edges.push(ancestor ? {
      id: `tag-hierarchy:${ancestor}>${tag.tag.id}`,
      from: `tag:${ancestor}`,
      to: tag.id,
      layer: "hierarchy",
      type: "tag-parent",
      label: "parent",
      directed: true,
      virtual: true,
    } : {
      id: `tag-hierarchy:root>${tag.tag.id}`,
      from: centerId,
      to: tag.id,
      layer: "hierarchy",
      type: "tag-root",
      label: "workspace",
      directed: true,
      virtual: true,
    });
  }
  edges.push(...buildTagRelatedEdges(relations, visibleTagIds));
  for (const goal of companyGoals) {
    // A company goal is anchored to the center, ALWAYS. Its tags still draw
    // their (faint) taxonomy memberships, but they never re-parent it: scope
    // is decided once, at creation, and persisted, so a tag added months
    // later during a taxonomy cleanup cannot quietly demote an objective the
    // company committed to into one more topic's child.
    edges.push({
      id: `goal-ring:${centerId}>${goal.id}`,
      from: centerId,
      to: goal.id,
      layer: "hierarchy",
      type: "goal-scope",
      label: northStar ? "north star" : "workspace",
      directed: true,
      virtual: true,
    });
  }

  return {
    centerId,
    centerPosition,
    centerColor,
    goalColor,
    goalPositions,
    tagPositions,
    tagDepths,
    edges,
  };
}

/**
 * Centrality rule for filtered graph views.
 *
 * "Hierarchy" is resolved with what the domain has:
 * 1. If the workspace defines any tag `parent` relations, a tag's rank is
 *    its hierarchy depth (1 = root, computed by the same cycle-safe BFS the
 *    radial layout uses). The candidate(s) with the SMALLEST depth win.
 * 2. If no hierarchy exists at all, assignment count is the proxy: the
 *    candidate(s) with the MOST assigned nodes win.
 *
 * Every candidate tied at the winning rank is returned — tied filters
 * become co-centers, rendered side by side and connected to each other.
 * Order is deterministic: assignment count desc, then id.
 */
export function pickCenterTags(
  candidateTagIds: readonly string[],
  relations: readonly TagRelation[],
  assignmentCountByTagId: ReadonlyMap<string, number>,
): string[] {
  const unique = [...new Set(candidateTagIds)];
  if (unique.length <= 1) return unique;
  const hasHierarchy = relations.some((relation) => relation.relation === "parent");
  const rankOf = new Map<string, number>();
  if (hasHierarchy) {
    const { depthById } = computeTagDepths(relations, new Set(unique));
    for (const id of unique) rankOf.set(id, depthById.get(id) ?? 1);
  } else {
    // Higher usage = higher hierarchy → smaller rank.
    for (const id of unique) rankOf.set(id, -(assignmentCountByTagId.get(id) ?? 0));
  }
  const best = Math.min(...unique.map((id) => rankOf.get(id)!));
  return unique
    .filter((id) => rankOf.get(id) === best)
    .sort((a, b) =>
      (assignmentCountByTagId.get(b) ?? 0) - (assignmentCountByTagId.get(a) ?? 0)
        || a.localeCompare(b),
    );
}

interface FilterCenteredLayout {
  /** Tag resource ids (`tag:<id>`), in pickCenterTags order. */
  centerResourceIds: string[];
  /** Keyed by tag resource id — includes the centers. */
  tagPositions: Map<string, { x: number; y: number }>;
  /** Display depth for non-center tags (1 = hangs directly off a center). */
  tagDepths: Map<string, number>;
  edges: GraphEdgePayload[];
}

/**
 * Radial layout rooted on the filter tag(s) instead of the workspace.
 *
 * A single center sits pinned at (0.5, 0.5); tied co-centers share a small
 * ring around the canvas center, each at the midpoint of its angular wedge,
 * connected to each other. Non-center tags visible in the result (the
 * co-tags of the filtered nodes) ring outward: real descendants of a center
 * nest inside that center's wedge via the shared subtree-wedge pass;
 * unrelated context tags get their own top-level wedges — they stay
 * connected to the view through the member nodes they share.
 */
export function buildFilterCenteredLayout(
  centerResourceIds: readonly string[],
  visibleTags: GraphTagPayload[],
  relations: readonly TagRelation[],
): FilterCenteredLayout {
  const centers = [...centerResourceIds];
  const centerRawIds = new Set(centers.map((id) => id.slice(4)));
  const visibleTagRawIds = new Set(visibleTags.map((tag) => tag.tag.id));
  const satellites = visibleTags.filter((tag) => !centerRawIds.has(tag.tag.id));

  const { primaryParentById } = computeTagDepths(relations, visibleTagRawIds);
  // Layout parent: nearest visible ancestor (center or satellite). Chains
  // through hidden tags collapse onto the closest rendered one.
  const layoutParentOf = new Map<string, string>();
  for (const tag of satellites) {
    const ancestor = nearestRenderedAncestor(tag.tag.id, primaryParentById, visibleTagRawIds);
    if (ancestor) layoutParentOf.set(tag.tag.id, ancestor);
  }
  const childrenOf = new Map<string, string[]>();
  const contextRoots: string[] = [];
  for (const tag of satellites) {
    const parent = layoutParentOf.get(tag.tag.id);
    if (parent) childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), tag.tag.id].sort());
    else contextRoots.push(tag.tag.id);
  }
  contextRoots.sort();

  // One shared wedge pass: centers first (their descendants nest inside),
  // then context roots. Weight = assigned-node mass, like the hub layout.
  const massById = new Map(visibleTags.map((tag) => [tag.tag.id, Math.max(1, tag.assignment_count)]));
  const topLevel = [...centers.map((id) => id.slice(4)), ...contextRoots];
  const angleById = assignSubtreeAngles(topLevel, childrenOf, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2, massById);

  // Ring depth per satellite: a center's direct child sits on ring 1, its
  // grandchild on ring 2; context roots (no visible ancestor) start on ring
  // 1 themselves, their children on ring 2.
  const ringDepthById = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = [
    ...centers.map((id) => ({ id: id.slice(4), depth: 0 })),
    ...contextRoots.map((id) => ({ id, depth: 1 })),
  ];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const { id, depth } = queue[cursor]!;
    if (ringDepthById.has(id)) continue;
    ringDepthById.set(id, depth);
    for (const child of childrenOf.get(id) ?? []) queue.push({ id: child, depth: depth + 1 });
  }

  const tagPositions = new Map<string, { x: number; y: number }>();
  const tagDepths = new Map<string, number>();
  const single = centers.length === 1;
  for (const center of centers) {
    const raw = center.slice(4);
    tagPositions.set(center, single
      ? { x: 0.5, y: 0.5 }
      : clampPoint({
        x: 0.5 + Math.cos(angleById.get(raw) ?? 0) * CO_CENTER_RING_RADIUS,
        y: 0.5 + Math.sin(angleById.get(raw) ?? 0) * CO_CENTER_RING_RADIUS,
      }));
  }
  const satelliteBase = single ? 0.19 : 0.24;
  for (const tag of satellites) {
    const raw = tag.tag.id;
    const depth = Math.min(MAX_TAG_HIERARCHY_DEPTH, Math.max(1, ringDepthById.get(raw) ?? 1));
    const radius = Math.min(0.44, satelliteBase + (depth - 1) * 0.115);
    const angle = angleById.get(raw) ?? 0;
    tagDepths.set(tag.id, depth);
    tagPositions.set(tag.id, clampPoint({
      x: 0.5 + Math.cos(angle) * radius,
      y: 0.5 + Math.sin(angle) * radius,
    }));
  }

  const edges: GraphEdgePayload[] = [];
  // Co-centers are peers of the same rank — link them explicitly.
  for (let i = 0; i < centers.length; i++) {
    for (let j = i + 1; j < centers.length; j++) {
      const key = [centers[i]!.slice(4), centers[j]!.slice(4)].sort().join("~");
      edges.push({
        id: `filter-co:${key}`,
        from: centers[i]!,
        to: centers[j]!,
        layer: "references",
        type: "co-filter",
        label: "co-filter",
        directed: false,
        virtual: true,
      });
    }
  }
  // Real taxonomy descent stays visible as hierarchy edges.
  for (const tag of satellites) {
    const parent = layoutParentOf.get(tag.tag.id);
    if (!parent) continue;
    edges.push({
      id: `tag-hierarchy:${parent}>${tag.tag.id}`,
      from: `tag:${parent}`,
      to: tag.id,
      layer: "hierarchy",
      type: "tag-parent",
      label: "parent",
      directed: true,
      virtual: true,
    });
  }
  edges.push(...buildTagRelatedEdges(relations, visibleTagRawIds));

  return { centerResourceIds: centers, tagPositions, tagDepths, edges };
}

/**
 * Deterministic positions for a filter-centered snapshot: centers and
 * satellite tags on their computed radial slots (persisted drags win for
 * everything except a single immovable center), content on sunflower orbits
 * around its anchor tag — the same seeding contract as the workspace hub.
 */
function filterCenteredPositions(
  layout: FilterCenteredLayout,
  contentNodes: readonly GraphCanonicalNodePayload[],
  primaryTagByNode: Map<string, string>,
  persisted: Record<string, { x: number; y: number }> = {},
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const single = layout.centerResourceIds.length === 1 ? layout.centerResourceIds[0]! : null;
  for (const [tagId, point] of layout.tagPositions) {
    out.set(tagId, tagId === single ? point : persistedPoint(persisted[tagId]) ?? point);
  }
  const slotByNode = new Map<string, number>();
  const countByAnchor = new Map<string, number>();
  for (const node of [...contentNodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const anchorId = primaryTagByNode.get(node.id) ?? layout.centerResourceIds[0]!;
    const slot = countByAnchor.get(anchorId) ?? 0;
    slotByNode.set(node.id, slot);
    countByAnchor.set(anchorId, slot + 1);
  }
  const centerSet = new Set(layout.centerResourceIds);
  for (const node of contentNodes) {
    const persistedNode = persistedPoint(persisted[node.id]);
    if (persistedNode) {
      out.set(node.id, persistedNode);
      continue;
    }
    const anchorId = primaryTagByNode.get(node.id) ?? layout.centerResourceIds[0]!;
    const anchor = layout.tagPositions.get(anchorId) ?? { x: 0.5, y: 0.5 };
    const bounds = centerSet.has(anchorId) ? HUB_ORBIT : TAG_ORBIT;
    out.set(node.id, clampPoint(orbitPoint(anchor, slotByNode.get(node.id) ?? 0, bounds)));
  }
  return out;
}

/**
 * Palette slot per workspace tag family, exactly as the UNFILTERED knowledge
 * graph's community assignment computes it client-side
 * (`assignGraphCommunities` in communities.ts): the rendered tag universe is
 * every active tag with at least one assignment; each rendered tag counts 1
 * toward its root family and each content node counts 1 toward its primary
 * (first rendered) tag's family; slots are ordered by family size
 * descending, ties by root tag name. Filter-centered snapshots ship this map
 * so the filter tag keeps the exact color it has in the main graph.
 */
export function workspaceCommunityPaletteSlots(
  nodes: KnowledgeNode[],
  relations: readonly TagRelation[],
): Record<string, number> {
  const tagById = new Map<string, WorkspaceTag>();
  for (const node of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const tag of node.tags) {
      if (!tag.id || tag.deleted_at || tag.merged_into_id) continue;
      if (!tagById.has(tag.id)) tagById.set(tag.id, tag);
    }
  }
  const visible = new Set(tagById.keys());
  const { primaryParentById } = computeTagDepths(relations, visible);
  const rootCache = new Map<string, string>();
  const rootOf = (id: string): string => {
    const cached = rootCache.get(id);
    if (cached) return cached;
    const seen = new Set([id]);
    let current = id;
    while (true) {
      const up = nearestRenderedAncestor(current, primaryParentById, visible);
      if (!up || seen.has(up)) break;
      seen.add(up);
      current = up;
    }
    for (const member of seen) rootCache.set(member, current);
    return current;
  };
  const sizeByRoot = new Map<string, number>();
  const bump = (rootId: string) => sizeByRoot.set(rootId, (sizeByRoot.get(rootId) ?? 0) + 1);
  for (const id of visible) bump(rootOf(id));
  for (const node of nodes) {
    const primary = node.tags.find((tag) =>
      tag.id && !tag.deleted_at && !tag.merged_into_id && visible.has(tag.id),
    );
    if (primary) bump(rootOf(primary.id));
  }
  const ordered = [...sizeByRoot.keys()].sort((a, b) =>
    (sizeByRoot.get(b)! - sizeByRoot.get(a)!)
      || (tagById.get(a)?.name ?? a).localeCompare(tagById.get(b)?.name ?? b),
  );
  return Object.fromEntries(ordered.map((id, index) => [`tag:${id}`, index]));
}

/** Symmetric `related` links between rendered tags, deduped per pair. */
function buildTagRelatedEdges(
  relations: readonly TagRelation[],
  visibleTagIds: ReadonlySet<string>,
): GraphEdgePayload[] {
  const edges: GraphEdgePayload[] = [];
  const seen = new Set<string>();
  for (const relation of relations) {
    if (relation.relation !== "related") continue;
    if (!visibleTagIds.has(relation.from_tag_id) || !visibleTagIds.has(relation.to_tag_id)) continue;
    if (relation.from_tag_id === relation.to_tag_id) continue;
    const key = [relation.from_tag_id, relation.to_tag_id].sort().join("~");
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      id: `tag-related:${key}`,
      from: `tag:${relation.from_tag_id}`,
      to: `tag:${relation.to_tag_id}`,
      layer: "references",
      type: "tag-related",
      label: "related",
      directed: false,
      virtual: true,
    });
  }
  return edges;
}

/**
 * Multi-source BFS over `relation: "parent"` edges (`from` = child, `to` =
 * parent). A tag with several parents gets the shortest path to any root; a
 * tag reachable from no root (an all-cycle component) safely falls back to
 * depth 1 rather than looping forever.
 */
function computeTagDepths(
  relations: readonly TagRelation[],
  knownTagIds: ReadonlySet<string>,
): { depthById: Map<string, number>; primaryParentById: Map<string, string> } {
  const childToParents = new Map<string, Set<string>>();
  const parentToChildren = new Map<string, Set<string>>();
  const allIds = new Set(knownTagIds);
  for (const relation of relations) {
    if (relation.relation !== "parent" || relation.from_tag_id === relation.to_tag_id) continue;
    allIds.add(relation.from_tag_id);
    allIds.add(relation.to_tag_id);
    if (!childToParents.has(relation.from_tag_id)) childToParents.set(relation.from_tag_id, new Set());
    childToParents.get(relation.from_tag_id)!.add(relation.to_tag_id);
    if (!parentToChildren.has(relation.to_tag_id)) parentToChildren.set(relation.to_tag_id, new Set());
    parentToChildren.get(relation.to_tag_id)!.add(relation.from_tag_id);
  }

  const depthById = new Map<string, number>();
  const roots = [...allIds].filter((id) => (childToParents.get(id)?.size ?? 0) === 0).sort();
  const queue: string[] = [];
  for (const root of roots) {
    depthById.set(root, 1);
    queue.push(root);
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor]!;
    const depth = depthById.get(id)!;
    if (depth >= MAX_TAG_HIERARCHY_DEPTH) continue;
    for (const child of [...(parentToChildren.get(id) ?? [])].sort()) {
      const candidate = depth + 1;
      const existing = depthById.get(child);
      if (existing === undefined || candidate < existing) {
        depthById.set(child, candidate);
        queue.push(child);
      }
    }
  }
  // Cycle-only components never get relaxed from a root — guard against the
  // infinite loop by treating them as (fallback) roots of their own.
  for (const id of allIds) if (!depthById.has(id)) depthById.set(id, 1);

  const primaryParentById = new Map<string, string>();
  for (const [child, parents] of childToParents) {
    const childDepth = depthById.get(child) ?? 1;
    const candidates = [...parents].filter((parent) => (depthById.get(parent) ?? Infinity) === childDepth - 1).sort();
    if (candidates[0]) primaryParentById.set(child, candidates[0]);
  }
  return { depthById, primaryParentById };
}

/** Walk the primary-parent chain until a rendered (visible) tag or the hub is reached. */
function nearestRenderedAncestor(
  tagId: string,
  primaryParentById: Map<string, string>,
  visibleTagIds: ReadonlySet<string>,
): string | null {
  const seen = new Set([tagId]);
  let current = primaryParentById.get(tagId);
  while (current) {
    if (seen.has(current)) return null;
    if (visibleTagIds.has(current)) return current;
    seen.add(current);
    current = primaryParentById.get(current);
  }
  return null;
}

/**
 * Radial tidy-tree, shared by the knowledge graph and `tags-graph-view.tsx`:
 * each tag gets an angular wedge proportional to its subtree's total mass
 * (its own assigned-node count plus the recursive mass of its children),
 * and every child is placed strictly inside its parent's wedge — so a
 * branch reads as one coherent slice from the hub outward, siblings land
 * contiguously, and a bigger subtree visibly claims more of the circle.
 */
function assignSubtreeAngles(
  ids: string[],
  childrenOf: Map<string, string[]>,
  start: number,
  end: number,
  ownMassById: Map<string, number>,
): Map<string, number> {
  const angleById = new Map<string, number>();
  const subtreeMassOf = (id: string, guard: Set<string>): number => {
    const own = ownMassById.get(id) ?? 1;
    if (guard.has(id)) return own;
    guard.add(id);
    const children = childrenOf.get(id) ?? [];
    return own + children.reduce((sum, child) => sum + subtreeMassOf(child, guard), 0);
  };
  const place = (nodeIds: string[], from: number, to: number) => {
    const weights = nodeIds.map((id) => subtreeMassOf(id, new Set()));
    const total = weights.reduce((sum, weight) => sum + weight, 0) || nodeIds.length || 1;
    let cursor = from;
    nodeIds.forEach((id, index) => {
      const span = ((to - from) * (weights[index]! / total)) || 0;
      angleById.set(id, cursor + span / 2);
      const children = childrenOf.get(id) ?? [];
      // Children are placed strictly inside their parent's [cursor, cursor+span)
      // wedge — never spread across the full ring — so the branch reads as one
      // coherent slice.
      if (children.length > 0) place(children, cursor, cursor + span);
      cursor += span;
    });
  };
  place(ids, start, end);
  return angleById;
}

/**
 * The workspace's North Star row, when the backfill has already given this
 * workspace one. SQL enforces at most one per workspace, but a snapshot must
 * stay deterministic even if that invariant is ever violated mid-migration,
 * so the smallest id wins. An archived North Star is treated as absent: the
 * graph hides archived nodes everywhere else, and a center nobody can see is
 * worse than the synthetic hub the fallback still draws.
 */
function findNorthStar(nodes: readonly KnowledgeNode[]): KnowledgeNode | null {
  const roots = nodes.filter((node) =>
    isStrategicGoal(node) && goalData(node).root === true && node.status !== "archived");
  return roots.sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
}

/**
 * Give the strategy layer a reading of its own. A goal that is part of the
 * result stays in the content lane — same id, same counts — but takes the
 * size and identity color that say "this is not one more note": the center
 * wears the gradient's head, the ring its tail, and both outsize every tag
 * hub. Tags keep the community palette. Ring, size and color then all carry
 * the same message, which is what makes a root ring that mixes taxonomy and
 * real nodes legible at all.
 */
function promoteStrategyNode<T extends GraphResourcePayload>(node: T, hub: TagHierarchyLayout | null): T {
  if (!hub) return node;
  if (node.id === hub.centerId) return { ...node, depth: 0, color: hub.centerColor, size: WORKSPACE_HUB_SIZE };
  if (hub.goalPositions.has(node.id)) return { ...node, depth: 0, color: hub.goalColor, size: GOAL_RING_SIZE };
  return node;
}

/** First valid, currently-rendered tag assigned to each node, in the node's own tag order. */
function primaryTagResourceByNode(
  nodes: KnowledgeNode[],
  candidates: ReadonlySet<string>,
  visibleTagResourceIds: ReadonlySet<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of nodes) {
    if (!candidates.has(node.id)) continue;
    for (const tag of node.tags) {
      if (!tag.id || tag.deleted_at || tag.merged_into_id) continue;
      const resourceId = `tag:${tag.id}`;
      if (visibleTagResourceIds.has(resourceId)) {
        out.set(node.id, resourceId);
        break;
      }
    }
  }
  return out;
}

/**
 * Content nodes whose entire connected component (over rendered non-semantic
 * node-to-node edges) contains no member with a visible primary tag. They
 * have no anchor anywhere in the tag-first radial layout, so the layout must
 * fix them itself instead of delegating to the force simulation.
 */
function anchorlessContentIds(
  contentIds: readonly string[],
  contentEdges: readonly GraphEdgePayload[],
  primaryTagByNode: ReadonlyMap<string, string>,
): Set<string> {
  const adjacency = new Map<string, string[]>(contentIds.map((id) => [id, []]));
  for (const edge of contentEdges) {
    // Semantic similarity is virtual and hidden by default — it must not
    // count as an anchor for a node that otherwise renders isolated.
    if (edge.layer === "semantic") continue;
    adjacency.get(edge.from)?.push(edge.to);
    adjacency.get(edge.to)?.push(edge.from);
  }
  const anchorless = new Set<string>();
  const visited = new Set<string>();
  for (const id of contentIds) {
    if (visited.has(id)) continue;
    const component = [id];
    visited.add(id);
    let anchored = false;
    for (let cursor = 0; cursor < component.length; cursor++) {
      const current = component[cursor]!;
      if (primaryTagByNode.has(current)) anchored = true;
      for (const neighbor of adjacency.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        component.push(neighbor);
      }
    }
    if (!anchored) for (const member of component) anchorless.add(member);
  }
  return anchorless;
}

/** Golden angle: consecutive orbit slots never align, at any count. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** 0.055 clears the hub glyph; 0.125 stays inside the innermost ring (goals at 0.18, tags at 0.16 without them). */
const HUB_ORBIT = { min: 0.055, max: 0.125 } as const;
/** Tag orbits stay inside a tag's own territory (inter-ring gap is 0.12). */
const TAG_ORBIT = { min: 0.05, max: 0.105 } as const;
/** Same idea one tier up: a goal glyph (9) is wider than a tag's, so its orbit starts further out. */
const GOAL_ORBIT = { min: 0.065, max: 0.115 } as const;

/**
 * Deterministic sunflower placement around an anchor: radius grows with
 * √slot so density stays even, and the golden-angle step spreads neighbors
 * apart. Unlike the old jittered ring — which stacked every co-anchored node
 * inside the same thin annulus — the seed layout is readable on its own,
 * which matters because it IS the final layout whenever ForceAtlas2 is
 * skipped (`prefers-reduced-motion`) and the first painted frame otherwise.
 */
function orbitPoint(
  anchor: { x: number; y: number },
  slot: number,
  bounds: { min: number; max: number },
): { x: number; y: number } {
  const radius = Math.min(bounds.max, bounds.min + 0.014 * Math.sqrt(slot));
  const angle = slot * GOLDEN_ANGLE - Math.PI / 2;
  return { x: anchor.x + Math.cos(angle) * radius, y: anchor.y + Math.sin(angle) * radius };
}

/**
 * Content nodes seed on a sunflower orbit around their primary tag, or
 * around the hub when untagged (always closer to the hub than to any tag —
 * they must read as "belongs to the workspace, not to a topic"). The
 * renderer's ForceAtlas2 pass then settles everything that is not pinned;
 * anchorless components are pinned by `buildGraphPayload` because the
 * simulation has no attraction for them.
 */
function knowledgeHubPositions(
  hub: TagHierarchyLayout,
  contentNodes: readonly GraphCanonicalNodePayload[],
  primaryTagByNode: Map<string, string>,
  persisted: Record<string, { x: number; y: number }> = {},
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  // The hub is an immovable landmark: (0.5, 0.5) always, immune to any
  // saved drag — see the `pinnedPositions` loop in `buildGraphPayload`.
  out.set(hub.centerId, hub.centerPosition);
  for (const [tagId, point] of hub.tagPositions) {
    out.set(tagId, persistedPoint(persisted[tagId]) ?? point);
  }
  // The strategy ring is computed geometry like the tag rings: a deliberate
  // drag may move a goal, the force pass may not.
  for (const [goalId, point] of hub.goalPositions) {
    out.set(goalId, persistedPoint(persisted[goalId]) ?? point);
  }
  // Landmarks are placed, not orbited — and they must not consume orbit
  // slots either, or the ring they sit on would shift every seed around it.
  const isLandmark = (id: string) => id === hub.centerId || hub.goalPositions.has(id);
  // Stable orbit slots: nodes sharing an anchor are ordered by id, so a
  // node's slot only shifts when the co-anchored set itself changes.
  const slotByNode = new Map<string, number>();
  const countByAnchor = new Map<string, number>();
  for (const node of [...contentNodes].sort((a, b) => a.id.localeCompare(b.id))) {
    if (isLandmark(node.id)) continue;
    const anchorId = primaryTagByNode.get(node.id) ?? hub.centerId;
    const slot = countByAnchor.get(anchorId) ?? 0;
    slotByNode.set(node.id, slot);
    countByAnchor.set(anchorId, slot + 1);
  }
  for (const node of contentNodes) {
    if (isLandmark(node.id)) continue;
    const persistedNode = persistedPoint(persisted[node.id]);
    if (persistedNode) {
      out.set(node.id, persistedNode);
      continue;
    }
    // One lookup covers every anchor kind, because `out` already holds the
    // fixed points: a tag hub, a goal on the strategy ring, or the center.
    const anchorId = primaryTagByNode.get(node.id);
    const anchor = (anchorId ? out.get(anchorId) : null) ?? hub.centerPosition;
    const bounds = anchor === hub.centerPosition
      ? HUB_ORBIT
      : anchorId && hub.goalPositions.has(anchorId) ? GOAL_ORBIT : TAG_ORBIT;
    const point = orbitPoint(anchor, slotByNode.get(node.id) ?? 0, bounds);
    out.set(node.id, clampPoint(point));
  }
  return out;
}

function clampPoint(point: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.max(0.04, Math.min(0.96, point.x)), y: Math.max(0.04, Math.min(0.96, point.y)) };
}

/**
 * Round-robin tag memberships so a single high-degree hub cannot monopolize
 * the bounded taxonomy lane. Input order never influences the result.
 */
export function fairCapMembershipEdges(
  edges: GraphEdgePayload[],
  maxEdges: number,
): GraphEdgePayload[] {
  const groups = new Map<string, GraphEdgePayload[]>();
  for (const edge of edges.filter((edge) => edge.layer === "taxonomy").sort((a, b) => a.id.localeCompare(b.id))) {
    const tagId = edge.from.startsWith("tag:") ? edge.from : edge.to;
    groups.set(tagId, [...(groups.get(tagId) ?? []), edge]);
  }
  const orderedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  const out: GraphEdgePayload[] = [];
  for (let round = 0; out.length < maxEdges; round++) {
    let added = false;
    for (const [, group] of orderedGroups) {
      const edge = group[round];
      if (!edge) continue;
      out.push(edge);
      added = true;
      if (out.length >= maxEdges) break;
    }
    if (!added) break;
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function relationCount(edges: GraphEdgePayload[]): number {
  return edges.reduce((total, edge) => total + (edge.aggregate_count ?? 1), 0);
}

function buildLayerEdges(
  nodes: KnowledgeNode[],
  durableEdges: NodeEdge[],
  candidates: Set<string>,
  layers: GraphLayer[],
): GraphEdgePayload[] {
  const enabled = new Set(layers);
  const edges = new Map<string, GraphEdgePayload>();
  const add = (edge: Omit<GraphEdgePayload, "id">) => {
    if (edge.from === edge.to || !candidates.has(edge.from) || !candidates.has(edge.to)) return;
    // A markdown mention and a durable `references` relation can describe
    // the same arrow. Collapse that logical duplicate while preserving
    // distinct typed dependencies between the same pair.
    const id = edge.layer === "references"
      ? `${edge.layer}:${edge.from}>${edge.to}`
      : `${edge.layer}:${edge.type}:${edge.from}>${edge.to}`;
    if (!edges.has(id)) edges.set(id, { id, ...edge });
  };

  if (enabled.has("hierarchy")) {
    for (const node of nodes) {
      if (!node.parent_id) continue;
      add({ from: node.parent_id, to: node.id, layer: "hierarchy", type: "child", label: "contains", directed: true, virtual: false });
    }
  }
  if (enabled.has("references")) {
    for (const node of nodes) {
      if (!candidates.has(node.id)) continue;
      for (const target of findForwardLinks(nodes, node)) {
        add({ from: node.id, to: target.id, layer: "references", type: "mention", label: target.block_id ? `mentions #${target.block_id}` : "mentions", directed: true, virtual: false });
      }
    }
  }
  for (const edge of durableEdges) {
    const references = edge.relation === "references" || edge.relation === "mentions";
    const layer: GraphLayer = references ? "references" : "dependencies";
    if (!enabled.has(layer)) continue;
    add({ from: edge.from_node, to: edge.to_node, layer, type: edge.relation, label: edge.relation.replaceAll("_", " "), directed: true, virtual: false });
  }
  if (enabled.has("semantic")) {
    for (const edge of buildVirtualSimilarityEdges(nodes.filter((node) => candidates.has(node.id)))) add(edge);
  }
  return [...edges.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function buildVirtualSimilarityEdges(nodes: KnowledgeNode[]): Array<Omit<GraphEdgePayload, "id">> {
  const candidates = [...nodes].sort((a, b) => a.id.localeCompare(b.id)).slice(0, GRAPH_LIMITS.maxSemanticCandidates);
  const features = new Map(candidates.map((node) => [node.id, semanticTokens(node)]));
  const scored: Array<Omit<GraphEdgePayload, "id">> = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const left = candidates[i]!;
      const right = candidates[j]!;
      const score = jaccard(features.get(left.id)!, features.get(right.id)!);
      if (score < 0.24) continue;
      scored.push({ from: left.id, to: right.id, layer: "semantic", type: "semantic_similarity", label: `${Math.round(score * 100)}% similar`, directed: false, virtual: true, score: Number(score.toFixed(3)) });
    }
  }
  return scored
    .sort((a, b) => (b.score! - a.score!) || `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`))
    .slice(0, GRAPH_LIMITS.maxSemanticEdges);
}

function semanticTokens(node: KnowledgeNode): Set<string> {
  const tokens = `${node.title} ${getNodeTags(node).join(" ")} ${node.content_md.slice(0, 600)}`
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return new Set(tokens.filter((token) => !STOP_WORDS.has(token)).slice(0, 80));
}

const STOP_WORDS = new Set(["the", "and", "for", "with", "this", "that", "from", "para", "con", "una", "del", "los", "las", "por", "que"]);

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export function traverseDepths(centerId: string, edges: GraphEdgePayload[], maxDepth: number): Map<string, number> {
  const adjacency = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a)!.add(b);
  };
  for (const edge of edges) {
    connect(edge.from, edge.to);
    connect(edge.to, edge.from);
  }
  const depths = new Map<string, number>([[centerId, 0]]);
  let frontier = [centerId];
  for (let depth = 1; depth <= Math.min(maxDepth, GRAPH_LIMITS.maxDepth); depth++) {
    const next: string[] = [];
    for (const id of frontier.sort()) {
      for (const neighbor of [...(adjacency.get(id) ?? [])].sort()) {
        if (depths.has(neighbor)) continue;
        depths.set(neighbor, depth);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return depths;
}

export function deterministicLayout(
  nodes: Array<{ id: string; depth: number }>,
  mode: GraphMode,
  centerId: string | null,
  persisted: Record<string, { x: number; y: number }> = {},
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  if (mode === "centered" && centerId) {
    out.set(centerId, persistedPoint(persisted[centerId]) ?? { x: 0.5, y: 0.5 });
    for (let depth = 1; depth <= GRAPH_LIMITS.maxDepth; depth++) {
      const ring = ordered.filter((node) => node.depth === depth);
      const radius = 0.12 + depth * 0.105;
      ring.forEach((node) => {
        const point = persistedPoint(persisted[node.id]);
        if (point) out.set(node.id, point);
        else {
          const angle = stableUnit(node.id, "angle") * Math.PI * 2 - Math.PI / 2;
          out.set(node.id, { x: 0.5 + Math.cos(angle) * radius, y: 0.5 + Math.sin(angle) * radius });
        }
      });
    }
  } else {
    ordered.forEach((node) => {
      const point = persistedPoint(persisted[node.id]);
      out.set(node.id, point ?? queryPoint(node.id, ordered.length, [...out.values()]));
    });
  }
  return out;
}

/**
 * Small query results are the common clustered overview. Put them on a
 * deterministic 3×4 field so readable cards cannot land on top of each
 * other. Larger results keep the stable hash distribution: a dense graph is
 * navigated with pan/zoom and must not reshuffle when its cap changes.
 */
function queryPoint(
  id: string,
  count: number,
  occupied: Array<{ x: number; y: number }>,
): { x: number; y: number } {
  if (count <= 12) {
    // A 24% side inset keeps 180px cluster cards inside narrow phone
    // viewports while retaining three useful columns on desktop.
    const columns = [0.24, 0.5, 0.76];
    const rows = [0.3, 0.48, 0.66, 0.82];
    const slots = rows.flatMap((y) => columns.map((x) => ({ x, y })));
    const start = Math.floor(stableUnit(id, "slot") * slots.length);
    for (let offset = 0; offset < slots.length; offset++) {
      const candidate = slots[(start + offset) % slots.length]!;
      const clear = occupied.every((point) =>
        Math.abs(candidate.x - point.x) >= 0.2 || Math.abs(candidate.y - point.y) >= 0.12,
      );
      if (clear) return candidate;
    }
  }
  return {
    x: 0.12 + stableUnit(id, "x") * 0.76,
    y: 0.22 + stableUnit(id, "y") * 0.64,
  };
}

function stableUnit(id: string, salt: string): number {
  let hash = 2166136261;
  const value = `${salt}:${id}`;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

/** Accessible text mirrors the visible edge label and arrow direction. */
export function describeNodeConnections(
  id: string,
  edges: GraphEdgePayload[],
  nodes: Array<Pick<GraphNodePayload, "id" | "title">>,
): string {
  const titles = new Map(nodes.map((node) => [node.id, node.title]));
  const related = edges
    .filter((edge) => edge.from === id || edge.to === id)
    .slice(0, 4)
    .map((edge) => {
      const outgoing = edge.from === id;
      const other = titles.get(outgoing ? edge.to : edge.from) ?? "node";
      return `${outgoing ? edge.label : `incoming ${edge.label}`} ${edge.directed ? (outgoing ? "to" : "from") : "with"} ${other}${edge.virtual ? " (virtual)" : ""}`;
    });
  return related.length > 0 ? related.join("; ") : "No visible connections";
}

export function nextGraphNodeId(
  currentId: string,
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
  positions: Map<string, { x: number; y: number }>,
): string | null {
  const current = positions.get(currentId);
  if (!current) return null;
  return [...positions.entries()]
    .filter(([id, point]) => {
      if (id === currentId) return false;
      if (key === "ArrowLeft") return point.x < current.x;
      if (key === "ArrowRight") return point.x > current.x;
      if (key === "ArrowUp") return point.y < current.y;
      return point.y > current.y;
    })
    .sort((a, b) => {
      const distanceA = Math.hypot(a[1].x - current.x, a[1].y - current.y);
      const distanceB = Math.hypot(b[1].x - current.x, b[1].y - current.y);
      return distanceA - distanceB || a[0].localeCompare(b[0]);
    })[0]?.[0] ?? null;
}

function persistedPoint(value: { x: number; y: number } | undefined) {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
  return { x: Math.max(0.04, Math.min(0.96, value.x)), y: Math.max(0.04, Math.min(0.96, value.y)) };
}

function uniqueLayers(values: readonly GraphLayer[]): GraphLayer[] {
  return ALL_LAYERS.filter((layer) => values.includes(layer));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function finitePositiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}
