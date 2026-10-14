/**
 * Current-truth signals for retrieval: staleness (edit age vs.
 * query frequency) and supersedes (a newer node explicitly replaces an
 * older one). Both degrade/label RAG hits — they never hard-filter, so a
 * superseded or stale node stays findable but visibly marked and ranked
 * lower (see `annotateStaleness` in this file, called from `rag.ts`).
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@bcontext-dev/contract/log";
import type { RagHit } from "@/lib/rag";

/** No edits in this many days = fully "aged" (staleness score of 1 from age alone). */
export const STALE_AGE_DAYS = 180;
/** Read within this many days = "actively consulted", halves the age-derived score. */
export const ACTIVE_READ_DAYS = 30;
/** Score at/above this is flagged `stale` on a hit. */
const STALE_SCORE_THRESHOLD = 0.7;
/** Similarity multiplier applied to stale (non-superseded) hits. */
const STALE_RANK_PENALTY = 0.85;
/** Similarity multiplier applied to superseded hits — stronger, since a newer node exists. */
const SUPERSEDED_RANK_PENALTY = 0.5;

function daysSince(iso: string | null | undefined, now: number): number {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return Math.max(0, (now - t) / 86_400_000);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Pure heuristic, v1: age alone would call anything unedited for
 * `STALE_AGE_DAYS` fully stale, but a node still being actively queried
 * clearly isn't dead knowledge — recent read activity halves the score.
 * Revisit thresholds once real usage data (`node_read_activity`, the AI
 * usage telemetry) accumulates.
 */
export function computeStalenessScore(
  input: { updatedAt: string; lastReadAt?: string | null },
  now: number = Date.now(),
): number {
  const ageScore = clamp01(daysSince(input.updatedAt, now) / STALE_AGE_DAYS);
  const recentlyRead = daysSince(input.lastReadAt, now) <= ACTIVE_READ_DAYS;
  return recentlyRead ? ageScore * 0.5 : ageScore;
}

/** Whether a `computeStalenessScore` result crosses the labeling threshold. */
export function isStale(score: number, threshold = STALE_SCORE_THRESHOLD): boolean {
  return score >= threshold;
}

/**
 * Best-effort: record that a node was surfaced as a retrieval result.
 * Never throws — a telemetry failure must never affect retrieval itself.
 */
export async function recordNodeRead(workspaceId: string, nodeId: string): Promise<void> {
  try {
    const sb = getSupabaseAdmin();
    const { data: existing } = await sb
      .from("node_read_activity")
      .select("read_count")
      .eq("node_id", nodeId)
      .maybeSingle();
    if (existing) {
      await sb
        .from("node_read_activity")
        .update({
          read_count: ((existing.read_count as number) ?? 0) + 1,
          last_read_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("node_id", nodeId);
    } else {
      await sb.from("node_read_activity").insert({
        node_id: nodeId,
        workspace_id: workspaceId,
        read_count: 1,
        last_read_at: new Date().toISOString(),
      });
    }
  } catch (err) {
    log.warn("rag.staleness.record_read_failed", {
      node_id: nodeId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface ReadActivityRow {
  last_read_at: string | null;
}

/** Last-read timestamps for a set of nodes; empty map on any error (best effort). */
export async function getReadActivityMap(
  nodeIds: string[],
): Promise<Map<string, ReadActivityRow>> {
  const map = new Map<string, ReadActivityRow>();
  if (nodeIds.length === 0) return map;
  try {
    const sb = getSupabaseAdmin();
    const { data } = await sb
      .from("node_read_activity")
      .select("node_id, last_read_at")
      .in("node_id", nodeIds);
    for (const row of (data ?? []) as Array<{ node_id: string; last_read_at: string | null }>) {
      map.set(row.node_id, { last_read_at: row.last_read_at });
    }
  } catch (err) {
    log.warn("rag.staleness.read_activity_lookup_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return map;
}

async function getSupersededByMap(nodeIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (nodeIds.length === 0) return map;
  try {
    const sb = getSupabaseAdmin();
    const { data } = await sb
      .from("edges")
      .select("from_node, to_node")
      .eq("relation", "supersedes")
      .in("to_node", nodeIds);
    for (const row of (data ?? []) as Array<{ from_node: string; to_node: string }>) {
      // If several nodes supersede the same one, the first hit wins — a
      // superseded node having multiple would-be successors is a data
      // quality issue outside this function's scope.
      if (!map.has(row.to_node)) map.set(row.to_node, row.from_node);
    }
  } catch (err) {
    log.warn("rag.staleness.supersedes_lookup_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return map;
}

async function getNodeUpdatedAtMap(nodeIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (nodeIds.length === 0) return map;
  try {
    const sb = getSupabaseAdmin();
    const { data } = await sb.from("nodes").select("id, updated_at").in("id", nodeIds);
    for (const row of (data ?? []) as Array<{ id: string; updated_at: string }>) {
      map.set(row.id, row.updated_at);
    }
  } catch (err) {
    log.warn("rag.staleness.updated_at_lookup_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return map;
}

/**
 * Annotate hits with `stale`/`superseded_by`, degrade their similarity
 * (superseded hits more than merely-stale ones), and re-sort. Best-effort
 * end to end — any lookup failure leaves the affected hits unannotated
 * rather than failing the whole retrieval; hits are never dropped, only
 * re-ranked and labeled.
 */
export async function annotateStaleness(
  workspaceId: string,
  hits: RagHit[],
): Promise<RagHit[]> {
  if (hits.length === 0) return hits;
  const nodeIds = Array.from(new Set(hits.map((h) => h.node_id)));

  const [readActivity, supersededBy, updatedAt] = await Promise.all([
    getReadActivityMap(nodeIds),
    getSupersededByMap(nodeIds),
    getNodeUpdatedAtMap(nodeIds),
  ]);

  // Fire-and-forget: every returned hit counts as a "consult" for staleness
  // purposes. Never awaited — must not add latency to the retrieval path.
  for (const id of nodeIds) {
    void recordNodeRead(workspaceId, id).catch(() => {});
  }

  const now = Date.now();
  const annotated = hits.map((hit): RagHit => {
    const updated = updatedAt.get(hit.node_id);
    const superseded = supersededBy.get(hit.node_id) ?? null;
    if (!updated) return hit;
    const score = computeStalenessScore(
      { updatedAt: updated, lastReadAt: readActivity.get(hit.node_id)?.last_read_at ?? null },
      now,
    );
    const stale = isStale(score);
    let similarity = hit.similarity;
    if (superseded) similarity *= SUPERSEDED_RANK_PENALTY;
    else if (stale) similarity *= STALE_RANK_PENALTY;
    return {
      ...hit,
      stale,
      superseded_by: superseded,
      similarity: Number(similarity.toFixed(4)),
    };
  });

  return annotated.sort((a, b) => b.similarity - a.similarity);
}
