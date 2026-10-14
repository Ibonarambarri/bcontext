/**
 * Graph expansion — 1-hop neighbors of top hits.
 *
 * After hybrid search returns its top-k hits, retrieval quality on
 * "connective" questions ("which decisions affect project X?") improves
 * when we surface nodes that are *adjacent* in the project graph even
 * when their text alone didn't match the query.
 *
 * This module is the pure piece of that pipeline: given a set of hits and
 * a snapshot of the workspace's graph (parent_id tree + optional typed
 * edges), it returns the 1-hop neighbors of the top hits, annotated as
 * `expanded: true`, deduped against the existing hits, and with a slightly
 * dampened similarity score so they sort *below* direct matches but stay
 * visible.
 *
 * v1 scope:
 *   - 1 hop only (no recursive walk — quality drops fast past hop 1).
 *   - Expand only the top-N hits (default 5).
 *   - Uses the `parent_id` tree for "is-child / is-parent" edges plus the
 *     `edges` table when present. No PPR yet (followup).
 *   - Pure: callers fetch the candidate node + edge snapshot, this helper
 *     does the graph math and tagging.
 *
 * The shape returned is `RagHit & { expanded: true; relation?: string }`
 * so it slots straight into the existing `citationsFromHits` pipeline.
 * Expanded hits carry `chunk_index: null` because they represent whole-node
 * context, not a specific chunk — citations still resolve to the node URL,
 * just without a `?highlight=`.
 */
import type { NodeKind } from "@bcontext-dev/contract/types";
import type { RagHit } from "@/lib/rag";

/**
 * A minimal node projection — only the fields graph expansion needs. Kept
 * narrow so the caller can pass either full `KnowledgeNode` rows or a
 * lighter SQL projection without type gymnastics.
 */
export interface ExpandNode {
  id: string;
  parent_id: string | null;
  kind: NodeKind;
  title: string;
  content_md: string;
}

/**
 * A typed edge as stored in the `edges` table. `from_node` and `to_node`
 * are node ids; `relation` is a freeform label (e.g. `relates_to`,
 * `blocks`, `decided_by`).
 */
export interface ExpandEdge {
  from_node: string;
  to_node: string;
  relation: string;
}

export interface ExpandOpts {
  /** How many of the top hits to expand from. Default 5. */
  topN?: number;
  /** Max expanded hits returned. Default 5. */
  maxExpanded?: number;
  /**
   * Multiplier applied to the seed hit's similarity to score the expanded
   * neighbor. Default 0.5 so expanded hits sit comfortably below direct
   * matches but stay above the noise floor.
   */
  scoreDecay?: number;
  /**
   * Max characters of `content_md` to surface in the expanded hit's
   * `content`. Default 800 — enough for the model to see the gist
   * without blowing the context budget.
   */
  contentPreviewChars?: number;
  /** Candidate ids allowed by the explicit scope. Null means workspace. */
  allowedNodeIds?: ReadonlySet<string> | null;
  /** Strict drops outside neighbors; broad returns them with an explicit tag. */
  scopeMode?: "strict" | "broad";
}

export interface ExpandedHit extends RagHit {
  /** Always true for hits produced by `expandHitsWith1Hop`. */
  expanded: true;
  /** Edge label, e.g. `parent`, `child`, or the `edges.relation` value. */
  relation: string;
  /** Id of the seed hit this neighbor was expanded from. */
  via: string;
  expansion_scope: "inside_scope" | "outside_scope";
}

const DEFAULTS = {
  topN: 5,
  maxExpanded: 5,
  scoreDecay: 0.5,
  contentPreviewChars: 800,
  allowedNodeIds: null,
  scopeMode: "broad" as const,
};

/**
 * Compute the 1-hop expansion of `hits` against the supplied node + edge
 * snapshot.
 *
 * The caller is responsible for ensuring `nodes` and `edges` are scoped to
 * the right workspace; this helper does no IO.
 */
export function expandHitsWith1Hop(
  hits: RagHit[],
  nodes: ExpandNode[],
  edges: ExpandEdge[] = [],
  opts: ExpandOpts = {},
): ExpandedHit[] {
  const o = { ...DEFAULTS, ...opts };
  if (hits.length === 0) return [];

  const nodeById = new Map<string, ExpandNode>();
  for (const n of nodes) nodeById.set(n.id, n);

  const hitIds = new Set(hits.map((h) => h.node_id));
  const seeds = hits.slice(0, o.topN);

  // Build adjacency: for each seed, collect candidate neighbor ids with
  // their relation label. We dedupe per (seed, neighbor, relation) so the
  // same parent/child edge doesn't get counted twice from both sides.
  type Candidate = { seedId: string; seedScore: number; relation: string };
  const candidates = new Map<string, Candidate>();

  const addCandidate = (
    neighborId: string,
    seedId: string,
    seedScore: number,
    relation: string,
  ) => {
    if (!neighborId) return;
    // Skip self-edges and nodes already in the direct hit set — those are
    // either redundant or already represented at a higher score.
    if (neighborId === seedId) return;
    if (hitIds.has(neighborId)) return;
    if (!nodeById.has(neighborId)) return;
    if (o.scopeMode === "strict" && o.allowedNodeIds && !o.allowedNodeIds.has(neighborId)) return;
    // First seed to reach a neighbor wins the attribution. Hits are
    // ordered by similarity so the strongest seed sticks.
    if (candidates.has(neighborId)) return;
    candidates.set(neighborId, { seedId, seedScore, relation });
  };

  // Index edges by endpoint for O(1) lookup. Built lazily — skip when
  // the workspace has no edges.
  const edgesByFrom = new Map<string, ExpandEdge[]>();
  const edgesByTo = new Map<string, ExpandEdge[]>();
  for (const e of edges) {
    const f = edgesByFrom.get(e.from_node);
    if (f) f.push(e);
    else edgesByFrom.set(e.from_node, [e]);
    const t = edgesByTo.get(e.to_node);
    if (t) t.push(e);
    else edgesByTo.set(e.to_node, [e]);
  }

  // Pre-index children by parent so the parent->children walk is O(1).
  const childrenByParent = new Map<string, ExpandNode[]>();
  for (const n of nodes) {
    if (!n.parent_id) continue;
    const arr = childrenByParent.get(n.parent_id);
    if (arr) arr.push(n);
    else childrenByParent.set(n.parent_id, [n]);
  }

  for (const seed of seeds) {
    const seedNode = nodeById.get(seed.node_id);
    // Parent edge (seed -> its semantic parent).
    if (seedNode?.parent_id) {
      const parent = nodeById.get(seedNode.parent_id);
      if (parent) {
        addCandidate(parent.id, seed.node_id, seed.similarity, "parent");
      }
    }
    // Child edges (seed -> each child).
    const kids = childrenByParent.get(seed.node_id) ?? [];
    for (const kid of kids) {
      addCandidate(kid.id, seed.node_id, seed.similarity, "child");
    }
    // Typed edges in both directions.
    for (const e of edgesByFrom.get(seed.node_id) ?? []) {
      addCandidate(e.to_node, seed.node_id, seed.similarity, e.relation);
    }
    for (const e of edgesByTo.get(seed.node_id) ?? []) {
      addCandidate(e.from_node, seed.node_id, seed.similarity, e.relation);
    }
  }

  // Materialize candidates into RagHit-shaped rows, score them with the
  // configured decay, then sort + cap.
  const expanded: ExpandedHit[] = [];
  for (const [neighborId, c] of candidates) {
    const n = nodeById.get(neighborId)!;
    expanded.push({
      node_id: n.id,
      title: n.title,
      kind: n.kind,
      content: (n.content_md ?? "").slice(0, o.contentPreviewChars),
      similarity: Number((c.seedScore * o.scoreDecay).toFixed(4)),
      // Expanded hits represent whole-node context — citations resolve
      // to the node URL without a chunk anchor.
      chunk_index: null,
      // No block-level granularity for graph-expanded neighbors —
      // they're whole-node context, not a specific H2 section.
      block_id: null,
      expanded: true,
      relation: c.relation,
      via: c.seedId,
      expansion_scope:
        o.allowedNodeIds && !o.allowedNodeIds.has(n.id)
          ? "outside_scope"
          : "inside_scope",
    });
  }

  expanded.sort((a, b) => b.similarity - a.similarity);
  return expanded.slice(0, o.maxExpanded);
}

/**
 * Type guard for picking expanded hits out of a merged hit list. Cheap
 * enough to inline at call sites but exposed so UI / observability can
 * tag them.
 */
export function isExpandedHit(h: RagHit): h is ExpandedHit {
  return (h as Partial<ExpandedHit>).expanded === true;
}
