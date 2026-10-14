/**
 * Cross-encoder rerank step. After hybrid search returns top-N candidates,
 * send query + candidate texts to a reranking model and reorder by the
 * model's relevance score. The hybrid RRF score is what we use to *recall*
 * candidates; the rerank score is what we use to *rank* them.
 *
 * Provider: Vercel AI Gateway only. As of 2026-05 the gateway exposes Cohere
 * and Voyage rerank models with `type: "reranking"`. We call them through the
 * `ai` SDK's `rerank()` helper, not via REST, so the API key + base URL come
 * from the same AI_GATEWAY_API_KEY as the rest of the stack. An
 * OpenAI-compatible backend (`OPENAI_BASE_URL`) has no rerank endpoint, so
 * there the step is skipped and hits keep their hybrid order
 * (`rerankSupported` in `@/lib/ai/provider`).
 *
 * Resilience: any failure (missing key, network error, malformed response)
 * falls back to the original hit order with a structured warn. Rerank is
 * additive — never block retrieval on it.
 */
import { rerank as aiRerank } from "ai";
import type { RagHit } from "@/lib/rag";
import { log } from "@bcontext-dev/contract/log";
import { recordAiUsageEvent } from "@/lib/telemetry/ai-usage";
import { rerankSupported } from "@/lib/ai/provider";

/** Sentinel model used when neither the env nor the caller specifies one. */
export const DEFAULT_RERANK_MODEL = "cohere/rerank-v3.5";

/**
 * Minimum candidate count to bother calling the reranker. With <3 hits the
 * extra round-trip almost always costs more than it saves; the spec's
 * acceptance criteria also call this out explicitly.
 */
export const RERANK_MIN_CANDIDATES = 3;

/**
 * Soft cap on documents sent in one rerank call. Cohere rerank v3.5 has a
 * 4096-token document budget shared across all docs; v4 raises that to 32k.
 * We don't tokenize here — instead we cap the per-doc character count so
 * the total stays well under either ceiling.
 */
export const RERANK_DOC_CHAR_BUDGET = 2000;

export interface RerankOpts {
  /** Override model id. Falls back to `RERANK_MODEL` env, then default. */
  model?: string;
  /** Keep only the top-K reranked hits. When unset, returns all reranked. */
  topK?: number;
  /**
   * Optional escape hatch. Forces rerank to skip (returns input unchanged).
   * Used by tests + workspace settings.
   */
  enabled?: boolean;
  /** AI usage telemetry — when present, records one ai_usage_events row per call. */
  workspaceId?: string;
}

/**
 * Resolve which rerank model to use. Server env always wins so an operator
 * can pin the model without redeploying code; explicit opts come next; the
 * sentinel default is last.
 */
export function resolveRerankModel(override?: string | null): string {
  if (process.env.RERANK_MODEL) return process.env.RERANK_MODEL;
  if (override && override.trim()) return override.trim();
  return DEFAULT_RERANK_MODEL;
}

/**
 * Pure helper — derive the document string sent to the reranker for a hit.
 *
 * We prefix with the title so the model has a hint about doc identity even
 * when the chunk body is opaque (e.g. a code snippet without surrounding
 * prose). Then clamp to RERANK_DOC_CHAR_BUDGET so we stay inside the
 * provider's token ceiling without doing a real tokenization pass.
 */
export function hitToRerankDoc(hit: RagHit): string {
  const title = hit.title?.trim();
  const body = (hit.content ?? "").trim();
  const combined = title ? `${title}\n\n${body}` : body;
  if (combined.length <= RERANK_DOC_CHAR_BUDGET) return combined;
  return combined.slice(0, RERANK_DOC_CHAR_BUDGET);
}

/**
 * Pure helper — apply a list of `{ originalIndex, score }` rankings on top
 * of the original hits. The reranker may return fewer entries than were
 * sent (when `topN` is set) so we:
 *   1. Emit any reranked hit first, in score order, with `similarity`
 *      replaced by the rerank score (clamped to [0,1] and rounded to 4dp).
 *   2. Append any unreranked tail in original order, preserving their
 *      original similarity values.
 *   3. Slice to `topK` if provided.
 *
 * Index-based reorder, not identity-based, so duplicate node_ids (e.g.
 * multiple chunks of the same node) survive the rerank cleanly.
 */
export function applyRerankRanking(
  hits: RagHit[],
  ranking: ReadonlyArray<{ originalIndex: number; score: number }>,
  topK?: number,
): RagHit[] {
  if (hits.length === 0) return [];
  const seen = new Set<number>();
  const reranked: RagHit[] = [];
  for (const r of ranking) {
    const idx = r.originalIndex;
    if (
      typeof idx !== "number" ||
      idx < 0 ||
      idx >= hits.length ||
      seen.has(idx)
    ) {
      continue;
    }
    const src = hits[idx];
    if (!src) continue; // unreachable given the bounds check, but appeases noUncheckedIndexedAccess
    seen.add(idx);
    const score = Math.max(0, Math.min(1, Number(r.score) || 0));
    reranked.push({ ...src, similarity: Number(score.toFixed(4)) });
  }
  const tail: RagHit[] = [];
  for (let i = 0; i < hits.length; i += 1) {
    if (seen.has(i)) continue;
    const src = hits[i];
    if (src) tail.push(src);
  }
  const out = reranked.concat(tail);
  if (typeof topK === "number" && topK >= 0) return out.slice(0, topK);
  return out;
}

/**
 * Rerank a list of hits against a query and return them reordered.
 *
 *  - Returns the input unchanged when:
 *      * `opts.enabled === false`
 *      * `hits.length < RERANK_MIN_CANDIDATES`
 *      * the backend has no rerank (no gateway, or `OPENAI_BASE_URL` wins)
 *  - Falls back to original order (with a structured warn) on any error.
 *  - Slices to `opts.topK` when provided, both on the happy and fallback
 *    paths — the caller doesn't have to remember to slice twice.
 */
export async function rerankHits(
  query: string,
  hits: RagHit[],
  opts?: RerankOpts,
): Promise<RagHit[]> {
  const enabled = opts?.enabled ?? true;
  const sliceTail = (rows: RagHit[]) =>
    typeof opts?.topK === "number" && opts.topK >= 0
      ? rows.slice(0, opts.topK)
      : rows;

  if (!enabled) return sliceTail(hits);
  if (!query.trim()) return sliceTail(hits);
  if (hits.length < RERANK_MIN_CANDIDATES) return sliceTail(hits);
  if (!rerankSupported()) return sliceTail(hits);

  const model = resolveRerankModel(opts?.model);
  const documents = hits.map(hitToRerankDoc);
  try {
    const result = await aiRerank({
      model,
      query,
      documents,
      topN: opts?.topK,
    });
    if (opts?.workspaceId) {
      // The rerank provider doesn't report token usage. `input` carries the
      // number of documents sent; the pricing table turns that into
      // searches (one per 100 documents), which is how Cohere bills.
      void recordAiUsageEvent({
        workspaceId: opts.workspaceId,
        surface: "rerank",
        model,
        tokens: { input: documents.length },
      });
    }
    return applyRerankRanking(hits, result.ranking, opts?.topK);
  } catch (err) {
    log.warn("rag.rerank.failed", {
      model,
      candidates: hits.length,
      error: { message: err instanceof Error ? err.message : String(err) },
    });
    return sliceTail(hits);
  }
}
