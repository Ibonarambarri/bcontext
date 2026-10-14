/**
 * Retrieval entry point for `ask_rag`, `ask_nexo`, Nexo chat and the agent
 * context route. If Supabase + embeddings are configured we search pgvector
 * through the `hybrid_search` RPC (vector + BM25 with RRF; `match_nodes` as
 * the plain-vector fallback), then apply per-lane scoring, optional rerank,
 * graph expansion and staleness labels. Otherwise we fall back to a
 * keyword scorer over the in-memory demo store so the chat still works
 * locally and in tests.
 *
 * The permission boundary lives here: the caller's reach is intersected into
 * the candidate set before the search runs, so nothing out of reach can be
 * ranked, reranked or shown to a model.
 */
import { reachableIdsOf } from "@/lib/storage/scoped";
import { findWorkspaceByRef } from "@/lib/workspaces/resolve";
import { embed } from "ai";
import { aiConfigured, embeddingModel as aiEmbeddingModel, rerankSupported } from "@/lib/ai/provider";
import type { ChatCitation, KnowledgeNode, NodeKind } from "@bcontext-dev/contract/types";
import { listNodes, isSupabaseConfigured } from "@/lib/demo-store";
import { formatSnippet } from "@bcontext-dev/contract/rag/citation";
import {
  expandHitsWith1Hop,
  type ExpandEdge,
  type ExpandNode,
  type ExpandedHit,
} from "@/lib/rag/graph-expand";
import { rerankHits, RERANK_MIN_CANDIDATES } from "@/lib/rag/rerank";
import { annotateStaleness } from "@/lib/rag/staleness";
import { recordAiUsageEvent } from "@/lib/telemetry/ai-usage";
import type { Storage } from "@/lib/storage";
import type { ViewPrincipal } from "@bcontext-dev/contract/views/types";
import {
  resolveRetrievalScope,
  type ResolvedRetrievalScope,
  type RetrievalLane,
  type RetrievalScopeMetadata,
} from "@/lib/rag/scope";

const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;

/**
 * Resolve which embedding model to use for a request. Server env always wins;
 * a client-supplied override is honored only when `EMBEDDING_MODEL` is unset.
 */
export function resolveEmbeddingModel(override?: string | null): string {
  if (process.env.EMBEDDING_MODEL) return process.env.EMBEDDING_MODEL;
  if (override && override.trim()) return override.trim();
  return DEFAULT_EMBEDDING_MODEL;
}

export interface RagHit {
  node_id: string;
  title: string;
  kind: NodeKind;
  content: string;
  similarity: number;
  /**
   * 0-based index of the chunk inside the source node. `null` when the
   * retriever has no chunk granularity (memory fallback). Used by the
   * UI to deep-link citations to the matching chunk.
   */
  chunk_index: number | null;
  /**
   * Stable, in-node H2-derived block id (see `@bcontext-dev/contract/rag/chunk`).
   * `null` when the source row predates block ids (the next edit refreshes
   * its rows naturally via `scheduleEmbed`) or for the memory fallback.
   * Treat as "whole node" when null.
   */
  block_id: string | null;
  /** Candidate lanes that recalled this chunk (deduped before global rerank). */
  candidate_lanes?: string[];
  /** Present on graph-expanded hits so broad-scope additions stay visible. */
  expansion_scope?: "inside_scope" | "outside_scope";
  /**
   * Current-truth signals. `stale` combines edit age with query
   * frequency (see `src/lib/rag/staleness.ts`); `superseded_by` is set when
   * another node has an explicit `supersedes` edge onto this one. Both are
   * best-effort annotations, never a hard filter — a superseded/stale hit
   * stays in the results, ranked lower and visibly labeled.
   */
  stale?: boolean;
  superseded_by?: string | null;
}

export interface RagResult {
  hits: RagHit[];
  scope: RetrievalScopeMetadata;
}

export interface RetrieveOptions {
  k?: number;
  embeddingModel?: string;
  scope?: unknown;
  storage?: Storage;
  viewPrincipal?: ViewPrincipal;
  kinds?: NodeKind[];
  /**
   * Answer from the keyword scorer even when embeddings are configured. The
   * evaluation (`scripts/rag-eval.mjs`) scores both paths against the same
   * questions; nothing in the product sets this. `RAG_FORCE_KEYWORD=1` in
   * the environment does the same for a whole process.
   */
  forceKeyword?: boolean;
}

/** True when this request must skip the vector path. */
export function keywordForced(options: Pick<RetrieveOptions, "forceKeyword"> = {}): boolean {
  return options.forceKeyword === true || process.env.RAG_FORCE_KEYWORD === "1";
}

/** Convenience form of `retrieveScoped` for whole-workspace queries: hits only. */
export async function retrieve(
  workspaceSlug: string,
  query: string,
  k = 6,
  embeddingModel?: string,
): Promise<RagHit[]> {
  return (await retrieveScoped(workspaceSlug, query, {
    k,
    embeddingModel,
  })).hits;
}

/**
 * Full retrieval: resolves the workspace (`<org>/<ws>` ref or id), the
 * scope lanes and the principal's reach, then searches, merges, reranks and
 * annotates. `scope` metadata in the result tells the caller how the answer
 * was narrowed or widened.
 */
export async function retrieveScoped(
  workspaceRef: string,
  query: string,
  options: RetrieveOptions = {},
): Promise<RagResult> {
  const { getStorage, getStorageById } = await import("@/lib/storage");
  // `<org>/<workspace>` is how a workspace is named; a bare id is what
  // internal callers already holding the row pass. A bare slug is neither,
  // because it names as many workspaces as there are organizations using it.
  const isId =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(workspaceRef);
  const storage =
    options.storage ??
    (isId ? await getStorageById(workspaceRef) : await getStorage(workspaceRef));
  if (!storage) throw new Error(`workspace not found: ${workspaceRef}`);
  const resolvedScope = await resolveRetrievalScope({
    storage,
    scope: options.scope,
    principal: options.viewPrincipal,
    kinds: options.kinds,
  });
  if (!query.trim()) return { hits: [], scope: resolvedScope.metadata };

  const k = options.k ?? 6;

  // The principal's reach, as a hard candidate boundary. This is NOT the same
  // thing as `resolvedScope`: that one is a query lens built to widen — `auto`
  // always keeps a global lane and `can_expand_to_workspace` is a first-class
  // field — while this one may only narrow. Migration 0039 says it plainly:
  // "match_node_ids is a candidate boundary, not an ACL". It is now both,
  // because the reach is intersected into it before the search runs.
  const reach = await reachableIdsOf(storage);

  if (!keywordForced(options) && isSupabaseConfigured() && aiConfigured()) {
    try {
      const hits = excludeOutOfReachHits(excludeCredentialHits(
        await retrieveFromSupabase(
          workspaceRef,
          query,
          k,
          options.embeddingModel,
          resolvedScope,
          reach,
        ),
      ), reach);
      return { hits, scope: scopeMetadataForHits(resolvedScope.metadata, hits) };
    } catch (err) {
      console.warn("[rag] supabase retrieval failed, falling back:", err);
    }
  }

  // The keyword path is the demo backend, the fallback when there are no
  // embeddings or the vector search throws, and what `forceKeyword` /
  // `RAG_FORCE_KEYWORD=1` ask for so it can be measured on its own (the
  // metadata still says `keyword_fallback`: same scorer, same coarseness,
  // and a caller reading the flag must not care why). It has to read the SAME storage
  // the caller holds — already narrowed to the principal's reach — and not the
  // in-memory demo store, which is empty for a Supabase workspace. It did read
  // the demo store, and a workspace without AI_GATEWAY_API_KEY answered every
  // search with zero hits over content that was plainly there: the agent lab
  // found it on its first day, and a rotated key in production would have
  // done the same, silently.
  const nodes = storage.backend === "demo" ? listNodes(workspaceRef) : await storage.listNodes();
  return {
    hits: excludeOutOfReachHits(
      excludeCredentialHits(retrieveFromMemory(nodes, query, k, resolvedScope)),
      reach,
    ),
    scope: { ...resolvedScope.metadata, keyword_fallback: true },
  };
}

/**
 * Security invariant: a `credential` node's secret values must never reach
 * the agent-facing surface. Credential nodes are never embedded (see
 * `embedNode`), so they can't surface via vector search — but the
 * keyword/BM25 memory fallback and graph-expansion neighbors both search
 * over raw title/content_md, so exclude the kind explicitly here as a
 * hard backstop, whatever lane or expansion produced the hit.
 */
function excludeCredentialHits(hits: RagHit[]): RagHit[] {
  return hits.filter((h) => h.kind !== "credential");
}

/**
 * Last line of defence: drop any hit outside the reach.
 *
 * The candidate boundaries passed into the RPCs and the expansion should have
 * made this a no-op — and that is the point. Credential exclusion already
 * taught this lesson the hard way: it needs two independent filters because the
 * BM25 fallback and the graph expansion read `title`/`content_md` directly and
 * never pass through the vector filter. A single boundary is one refactor away
 * from being bypassed, and here the failure is silent and returns other
 * tenants' prose inside cited snippets.
 */
/**
 * Intersect every retrieval lane with the reach.
 *
 * A lane with `node_ids: null` means "the whole workspace". For a narrowed
 * principal that must become "the reach" instead of staying unbounded — and it
 * is not a corner case: the `auto` scope *always* adds a global lane, by
 * contract, so it is the lane most likely to walk straight past the grant.
 */
export function boundLanesToReach(
  lanes: readonly RetrievalLane[],
  reach: Set<string> | null,
): RetrievalLane[] {
  if (!reach) return [...lanes];
  return lanes.map((lane) => ({
    ...lane,
    node_ids: lane.node_ids ? lane.node_ids.filter((id) => reach.has(id)) : [...reach],
  }));
}

function excludeOutOfReachHits(hits: RagHit[], reach: Set<string> | null): RagHit[] {
  if (!reach) return hits;
  return hits.filter((h) => reach.has(h.node_id));
}

function scopeMetadataForHits(metadata: RetrievalScopeMetadata, hits: RagHit[]): RetrievalScopeMetadata {
  return hits.some((hit) => hit.expansion_scope === "outside_scope")
    ? { ...metadata, expanded_to_workspace: true }
    : metadata;
}

async function retrieveFromSupabase(
  workspaceSlug: string,
  query: string,
  k: number,
  embeddingModel?: string,
  resolvedScope?: ResolvedRetrievalScope,
  /** Hard candidate boundary from the principal's grant. `null` = unrestricted. */
  reach?: Set<string> | null,
): Promise<RagHit[]> {
  const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
  const supa = getSupabaseAdmin();

  const ws = await findWorkspaceByRef(workspaceSlug, "id");
  if (!ws) return [];
  const workspaceId = ws.id as string;

  const queryEmbeddingModel = embeddingModel || EMBEDDING_MODEL;
  const { embedding, usage: embedUsage } = await embed({
    model: aiEmbeddingModel(queryEmbeddingModel),
    value: query,
  });
  void recordAiUsageEvent({
    workspaceId: workspaceId,
    surface: "query_embed",
    model: queryEmbeddingModel,
    tokens: { input: embedUsage?.tokens ?? 0 },
  });

  // Try hybrid (pgvector + BM25 + RRF). Falls back to plain vector match
  // if the function isn't installed yet (older deployments).
  // `embedding_version_filter` scopes results to chunks produced by the
  // same model — never mix vector spaces across models.
  //
  // When we plan to rerank we ask hybrid_search for more candidates than
  // the caller's final `k` so the cross-encoder has room to reorder. The
  // overshoot is bounded — sending more than ~20 docs to rerank rarely
  // helps quality and starts to dominate latency.
  const versionTag = embeddingModel || EMBEDDING_MODEL;
  const RERANK_CANDIDATE_POOL = 20;
  const hybridCount =
    rerankSupported() && k >= RERANK_MIN_CANDIDATES
      ? Math.max(k, RERANK_CANDIDATE_POOL)
      : k;
  const lanes = resolvedScope?.lanes ?? [{ name: "workspace", node_ids: null, boost: 1 } satisfies RetrievalLane];
  const boundLanes = boundLanesToReach(lanes, reach ?? null);
  const laneResults = await Promise.all(boundLanes.map(async (lane) => {
    if (lane.node_ids && lane.node_ids.length === 0) return { lane, hits: [] as RagHit[] };
    const hybrid = await supa.rpc("hybrid_search", {
      query_text: query,
      query_embedding: embedding,
      match_workspace: workspaceId,
      match_count: hybridCount,
      embedding_version_filter: versionTag,
      match_node_ids: lane.node_ids,
    });
    if (hybrid.error) throw hybrid.error;
    const hits: RagHit[] = ((hybrid.data ?? []) as HybridRow[]).map((row) => ({
        node_id: row.node_id,
        title: row.title,
        kind: row.kind,
        content: row.content,
        chunk_index: typeof row.chunk_index === "number" ? row.chunk_index : null,
        block_id: extractBlockId(row.metadata),
        similarity: Number(row.rrf_score?.toFixed?.(4) ?? row.rrf_score ?? 0),
        candidate_lanes: [lane.name],
      }));
    return { lane, hits };
  }));

  if (laneResults.some((result) => result.hits.length > 0)) {
    // Each lane has its own score distribution. Normalize inside the lane,
    // apply its boost, dedupe, then run one global rerank. Raw RRF scores
    // from independent searches are never compared directly.
    const candidates = mergeCandidateLanes(laneResults).slice(0, 40);
    const base = await rerankHits(query, candidates, { topK: k, workspaceId: workspaceId });
    // Expand top hits with 1-hop neighbors via parent/child + typed edges.
    // Best-effort: any error here just returns the base hits — graph
    // expansion is additive context, never a hard dependency.
    const expanded = await loadAndExpand(supa, workspaceId, base, 5, resolvedScope, reach);
    return annotateStaleness(workspaceId, base.concat(expanded));
  }

  // Compatibility fallback for deployments where scoped hybrid_search has
  // not landed yet. It still receives the pre-resolved candidate ids.
  const scopeIds = resolvedScope?.strict_node_ids
    ? [...resolvedScope.strict_node_ids]
    : null;
  // The fallback path reads title/content directly and never passes through the
  // vector filter — the same reason the credential exclusion needs two
  // independent checks. Bound it explicitly.
  const fallbackIds = reach
    ? (scopeIds ?? [...reach]).filter((id) => reach.has(id))
    : scopeIds;
  if (fallbackIds && fallbackIds.length === 0) return [];
  const { data, error } = await supa.rpc("match_nodes", {
    query_embedding: embedding,
    match_workspace: workspaceId,
    match_count: k,
    similarity_threshold: 0.2,
    embedding_version_filter: versionTag,
    match_node_ids: fallbackIds,
  });
  if (error) throw error;

  const fallbackHits: RagHit[] = (data ?? []).map(
    (row: {
      node_id: string;
      title: string;
      kind: NodeKind;
      content: string;
      similarity: number;
      chunk_index?: number | null;
      metadata?: unknown;
    }) => ({
      node_id: row.node_id,
      title: row.title,
      kind: row.kind,
      content: row.content,
      similarity: row.similarity,
      chunk_index: typeof row.chunk_index === "number" ? row.chunk_index : null,
      block_id: extractBlockId(row.metadata),
    }),
  );
  return annotateStaleness(workspaceId, fallbackHits);
}

/**
 * Pull `block_id` out of an embeddings row's `metadata` JSONB. Returns
 * `null` for rows that predate block ids (no `block_id` in metadata) and for
 * any malformed value. Treat null as "whole node" downstream.
 */
function extractBlockId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const v = (metadata as { block_id?: unknown }).block_id;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Fetch the candidate node + edge snapshot for the seeds in `hits` and
 * run 1-hop graph expansion. Pure helper does the math — this wrapper
 * just feeds it. Errors are swallowed and an empty array returned so
 * that retrieval still succeeds on workspaces without edges/permissions.
 */
async function loadAndExpand(
  // Use a structurally-typed supabase client so we don't need to import
  // the supabase types here.
  supa: {
    from: (t: string) => {
      select: (cols: string) => {
        eq: (col: string, val: string) => {
          in: (
            col: string,
            vals: string[],
          ) => Promise<{ data: unknown; error: unknown }>;
        };
      };
    };
  },
  workspaceId: string,
  hits: RagHit[],
  topN = 5,
  resolvedScope?: ResolvedRetrievalScope,
  /** Hard boundary from the grant. Applied regardless of graph_expansion mode. */
  reach?: Set<string> | null,
): Promise<ExpandedHit[]> {
  if (hits.length === 0) return [];
  const seedIds = Array.from(new Set(hits.slice(0, topN).map((h) => h.node_id)));
  try {
    // Pull the seeds themselves + any parents/children. The pure helper
    // computes the actual graph; we just have to make sure the relevant
    // nodes are loaded so it can resolve titles + previews.
    const seedsRes = await supa
      .from("nodes")
      .select("id, parent_id, kind, title, content_md")
      .eq("workspace_id", workspaceId)
      .in("id", seedIds);
    if (seedsRes.error) return [];
    const seeds = (seedsRes.data as ExpandNode[]) ?? [];

    const parentIds = Array.from(
      new Set(seeds.map((s) => s.parent_id).filter((v): v is string => !!v)),
    );

    // Parents (one ancestor per seed) and children (all kids of any seed)
    // in a single query each. Children are looked up by parent_id IN seeds.
    const [parentsRes, childrenRes, edgesFromRes, edgesToRes] = await Promise.all([
      parentIds.length > 0
        ? supa
            .from("nodes")
            .select("id, parent_id, kind, title, content_md")
            .eq("workspace_id", workspaceId)
            .in("id", parentIds)
        : Promise.resolve({ data: [], error: null }),
      supa
        .from("nodes")
        .select("id, parent_id, kind, title, content_md")
        .eq("workspace_id", workspaceId)
        .in("parent_id", seedIds),
      supa
        .from("edges")
        .select("from_node, to_node, relation")
        .eq("workspace_id", workspaceId)
        .in("from_node", seedIds),
      supa
        .from("edges")
        .select("from_node, to_node, relation")
        .eq("workspace_id", workspaceId)
        .in("to_node", seedIds),
    ]);

    const parents = (parentsRes.error ? [] : (parentsRes.data as ExpandNode[])) ?? [];
    const children =
      (childrenRes.error ? [] : (childrenRes.data as ExpandNode[])) ?? [];
    const edgesFrom =
      (edgesFromRes.error ? [] : (edgesFromRes.data as ExpandEdge[])) ?? [];
    const edgesTo =
      (edgesToRes.error ? [] : (edgesToRes.data as ExpandEdge[])) ?? [];

    // Edge endpoints may point at nodes outside the seed neighborhood —
    // pull those too so the expander can resolve their content.
    const extraIds = new Set<string>();
    for (const e of edgesFrom) extraIds.add(e.to_node);
    for (const e of edgesTo) extraIds.add(e.from_node);
    for (const s of seeds) extraIds.delete(s.id);
    for (const p of parents) extraIds.delete(p.id);
    for (const c of children) extraIds.delete(c.id);
    let extras: ExpandNode[] = [];
    if (extraIds.size > 0) {
      const extrasRes = await supa
        .from("nodes")
        .select("id, parent_id, kind, title, content_md")
        .eq("workspace_id", workspaceId)
        .in("id", Array.from(extraIds));
      if (!extrasRes.error) extras = (extrasRes.data as ExpandNode[]) ?? [];
    }

    // Drop anything outside the reach before expansion runs, not after. The
    // existing `allowedNodeIds` below only bites when graph_expansion is
    // "strict", and it defaults to "broad" — so relying on it would let the
    // grant be widened by a scope option the caller controls. These five
    // queries filter by workspace alone and deliberately pull neighbours from
    // outside the neighbourhood, which is exactly how content escapes.
    const inReach = (id: string) => !reach || reach.has(id);
    const allNodes: ExpandNode[] = [
      ...seeds,
      ...parents,
      ...children,
      ...extras,
    ].filter((n) => inReach(n.id));
    const allEdges: ExpandEdge[] = [...edgesFrom, ...edgesTo].filter(
      (e) => inReach(e.from_node) && inReach(e.to_node),
    );
    return expandHitsWith1Hop(hits, allNodes, allEdges, {
      topN,
      allowedNodeIds: resolvedScope?.strict_node_ids ?? null,
      scopeMode: resolvedScope?.input.graph_expansion ?? "broad",
    });
  } catch (err) {
    console.warn("[rag] graph expansion failed:", err);
    return [];
  }
}

interface HybridRow {
  node_id: string;
  chunk_index: number;
  content: string;
  title: string;
  kind: NodeKind;
  vector_rank: number | null;
  bm25_rank: number | null;
  rrf_score: number;
  metadata?: unknown;
}

function retrieveFromMemory(
  allNodes: KnowledgeNode[],
  query: string,
  k: number,
  resolvedScope?: ResolvedRetrievalScope,
): RagHit[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  if (terms.length === 0) return [];

  const laneResults = (resolvedScope?.lanes ?? [{ name: "workspace", node_ids: null, boost: 1 } satisfies RetrievalLane])
    .map((lane) => {
      const allowed = lane.node_ids ? new Set(lane.node_ids) : null;
      const hits = allNodes
    // Candidate filtering happens before keyword scoring, mirroring the SQL
    // path and avoiding a post-filter security boundary.
    .filter((n) => !allowed || allowed.has(n.id))
    .map((n) => {
      const hay = (n.title + " " + n.content_md).toLowerCase();
      let score = 0;
      for (const t of terms) {
        const occurrences = hay.split(t).length - 1;
        score += occurrences * (n.title.toLowerCase().includes(t) ? 3 : 1);
      }
      return {
        node_id: n.id,
        title: n.title,
        kind: n.kind,
        content: n.content_md.slice(0, 1200),
        similarity: score,
        // Memory fallback returns whole nodes — no chunk granularity. The
        // citation still resolves to a clickable link, just without a
        // chunk highlight.
        chunk_index: null,
        // Memory fallback has no block-level granularity. Downstream
        // treats null as "whole node".
        block_id: null,
      };
    })
    .filter((h) => h.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, Math.max(k, 20))
    .map((h, _i, arr) => ({
      ...h,
      // Normalize the keyword score into a 0-1 range for display.
      similarity: arr[0]
        ? Number((h.similarity / arr[0].similarity).toFixed(2))
        : 0,
      candidate_lanes: [lane.name],
    }));
      return { lane, hits };
    });
  return mergeCandidateLanes(laneResults).slice(0, k);
}

/** Normalize each lane by deterministic rank, then dedupe for global rerank. */
export function mergeCandidateLanes(
  laneResults: Array<{ lane: RetrievalLane; hits: RagHit[] }>,
): RagHit[] {
  const merged = new Map<string, RagHit>();
  for (const { lane, hits } of laneResults) {
    const count = hits.length;
    hits.forEach((hit, index) => {
      const normalized = count === 0 ? 0 : (count - index) / count;
      const score = Number(Math.min(1, normalized * lane.boost).toFixed(4));
      const key = `${hit.node_id}:${hit.chunk_index ?? "node"}:${hit.block_id ?? ""}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...hit, similarity: score, candidate_lanes: [lane.name] });
        return;
      }
      const candidateLanes = [...new Set([...(existing.candidate_lanes ?? []), lane.name])].sort();
      if (score > existing.similarity) {
        merged.set(key, { ...hit, similarity: score, candidate_lanes: candidateLanes });
      } else {
        existing.candidate_lanes = candidateLanes;
      }
    });
  }
  return [...merged.values()].sort((a, b) =>
    b.similarity - a.similarity
    || a.node_id.localeCompare(b.node_id)
    || (a.chunk_index ?? -1) - (b.chunk_index ?? -1));
}

/** Reference path for a hit — block-anchored when the retriever knows the H2. */
export function refForHit(h: Pick<RagHit, "node_id" | "block_id">): string {
  return h.block_id ? `/n/${h.node_id}#${h.block_id}` : `/n/${h.node_id}`;
}

/** Chat-facing citation shape (`ChatCitation`) for a list of hits. */
export function citationsFromHits(hits: RagHit[]): ChatCitation[] {
  return hits.map((h) => ({
    node_id: h.node_id,
    title: h.title,
    kind: h.kind,
    similarity: h.similarity,
    chunk_index: h.chunk_index,
    block_id: h.block_id,
    ref: refForHit(h),
    snippet: formatSnippet(h.content),
    superseded_by: h.superseded_by ?? null,
    stale: h.stale ?? false,
  }));
}

export interface GroupedHit {
  node_id: string;
  title: string;
  kind: NodeKind;
  /** Best (max) score across the node's matching blocks. */
  score: number;
  blocks: Array<{
    block_id: string | null;
    chunk_index: number | null;
    score: number;
    snippet: string | null;
    ref: string;
  }>;
}

/**
 * Collapse block-granular hits into one entry per node, best block first.
 * Ordering: nodes by their best block's rank in the incoming (already
 * ranked) hit list, blocks within a node by score. This is what
 * `nodes(op=search)` returns so an agent never sees the same node 3× just
 * because 3 of its H2 sections matched.
 */
export function groupHitsByNode(
  hits: RagHit[],
  snippetChars = 240,
): GroupedHit[] {
  const byNode = new Map<string, GroupedHit>();
  for (const h of hits) {
    let g = byNode.get(h.node_id);
    if (!g) {
      g = {
        node_id: h.node_id,
        title: h.title,
        kind: h.kind,
        score: h.similarity,
        blocks: [],
      };
      byNode.set(h.node_id, g);
    }
    g.score = Math.max(g.score, h.similarity);
    g.blocks.push({
      block_id: h.block_id,
      chunk_index: h.chunk_index,
      score: h.similarity,
      snippet: h.content ? h.content.slice(0, snippetChars) : null,
      ref: refForHit(h),
    });
  }
  const groups = Array.from(byNode.values());
  for (const g of groups) g.blocks.sort((a, b) => b.score - a.score);
  return groups;
}
