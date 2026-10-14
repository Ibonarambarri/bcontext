/**
 * Per-call AI usage/cost telemetry.
 *
 * Records one row per AI call into `ai_usage_events`: workspace, subject,
 * surface, model, token counts and cost. Never records prompt or response
 * text — the input type below is exhaustive; there is no field to smuggle
 * free text into beyond the caller-controlled `metadata` bag, which callers
 * must only populate with identifiers (node_id, skill_slug, finish_reason),
 * never content.
 *
 * Writes go through the service-role client and are always best-effort:
 * a telemetry failure must never break the AI call it's describing.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { log } from "@bcontext-dev/contract/log";

export type AiUsageSurface =
  | "chat"
  | "nexo"
  | "autofix"
  | "skill_run"
  | "meeting_refine"
  | "ask_rag"
  | "ask_nexo"
  | "contextualize"
  | "embed"
  | "query_embed"
  | "rerank"
  | "ingest_extract"
  | "integration_setup";

/**
 * Token counts as the AI SDK reports them. `input` is the WHOLE prompt —
 * the SDK's `inputTokens` is `noCache + cacheRead + cacheWrite`, and it is
 * what lands in `tokens_input` — while `cached` and `cacheWrite` name the
 * parts of it the provider read from or wrote to its prompt cache. Pricing
 * subtracts them from `input` before applying the base rate; treating
 * `input` as the uncached part billed every cached token twice.
 */
export interface AiUsageTokens {
  input?: number;
  output?: number;
  /** Prompt tokens served from the provider's cache (cheap). */
  cached?: number;
  /**
   * Prompt tokens written into the cache this call (Anthropic bills them
   * above the base rate). Priced, not stored: the ledger has no column for
   * them, and they are already inside `input`.
   */
  cacheWrite?: number;
}

export interface RecordAiUsageEventInput {
  workspaceId: string;
  subjectUserId?: string | null;
  surface: AiUsageSurface;
  model: string;
  tokens?: AiUsageTokens;
  /** Cost in USD read from provider-reported metadata, when available. */
  providerCostUsd?: number | null;
  /**
   * The AI SDK result's `providerMetadata`. When the call went through the
   * AI Gateway it carries the generation's real cost, which beats any table
   * below — pass it and `providerCostUsd` is derived for you.
   */
  providerMetadata?: Record<string, Record<string, unknown>> | undefined;
  success?: boolean;
  /** Dedupe key for retries of the same logical call. */
  requestId?: string | null;
  /** Identifiers only (node_id, skill_slug, finish_reason...) — never prompt/response text. */
  metadata?: Record<string, string | number | boolean | null>;
}

// Per-model fallback pricing (USD per 1M tokens), used when the provider
// doesn't report cost in its response metadata. Last reviewed 2026-09-16
// against https://ai-gateway.vercel.sh/v1/models.
interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  /** Prompt tokens read from the cache. Defaults to the base input rate. */
  cachedPer1M?: number;
  /** Prompt tokens written to the cache. Defaults to the base input rate. */
  cacheWritePer1M?: number;
  /**
   * Rerankers are not sold by the token: Cohere bills a "search" — one
   * query against up to `perSearchDocs` documents. A model with this set is
   * priced per search from `tokens.input`, which the rerank surface fills
   * with the number of documents sent.
   */
  perSearchUsd?: number;
  perSearchDocs?: number;
}

// Gateway list prices (https://ai-gateway.vercel.sh/v1/models) on the
// version date. Only the models the product can be configured with; an
// unknown model records cost 0 and `cost_source: "unpriced"`, which the
// spend figures read as free and the admin panel counts in red — add the
// row before pointing a `*_MODEL` variable at a new model. Anthropic's cache write rate is 1.25×
// the input rate; the other providers report no cache writes.
const FALLBACK_PRICING: Record<string, ModelPricing> = {
  "anthropic/claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15, cachedPer1M: 0.3, cacheWritePer1M: 3.75 },
  "anthropic/claude-sonnet-5": { inputPer1M: 2, outputPer1M: 10, cachedPer1M: 0.2, cacheWritePer1M: 2.5 },
  "anthropic/claude-haiku-4-5": { inputPer1M: 1, outputPer1M: 5, cachedPer1M: 0.1, cacheWritePer1M: 1.25 },
  "openai/gpt-5-mini": { inputPer1M: 0.25, outputPer1M: 2, cachedPer1M: 0.025 },
  "openai/gpt-5-nano": { inputPer1M: 0.05, outputPer1M: 0.4, cachedPer1M: 0.005 },
  "google/gemini-2.5-flash-lite": { inputPer1M: 0.1, outputPer1M: 0.4, cachedPer1M: 0.01 },
  "google/gemini-3.1-flash-lite": { inputPer1M: 0.25, outputPer1M: 1.5, cachedPer1M: 0.03 },
  "google/gemini-3-flash": { inputPer1M: 0.5, outputPer1M: 3, cachedPer1M: 0.05 },
  "deepseek/deepseek-v4-flash": { inputPer1M: 0.13, outputPer1M: 0.26, cachedPer1M: 0.028 },
  "openai/text-embedding-3-small": { inputPer1M: 0.02, outputPer1M: 0 },
  // The gateway publishes no price for Cohere rerank; this is Cohere's list
  // price ($2 per 1,000 searches, a search being up to 100 documents). The
  // old per-document row undercounted a 20-document rerank fifty-fold.
  "cohere/rerank-v3.5": { inputPer1M: 0, outputPer1M: 0, perSearchUsd: 0.002, perSearchDocs: 100 },
};

// The catalog spells Anthropic models `claude-haiku-4.5`; the code and the
// env use `claude-haiku-4-5`. Both resolve at the gateway; price them once.
function pricingFor(model: string): ModelPricing | undefined {
  return FALLBACK_PRICING[model] ?? FALLBACK_PRICING[model.replace(/\.(\d)$/, "-$1")];
}

/**
 * The gateway reports what a generation actually cost, in USD, on
 * `providerMetadata.gateway.cost` (a string). Returns null when the call
 * did not go through the gateway or the field is missing, so callers fall
 * back to the table above.
 */
export function gatewayCostUsd(
  providerMetadata: Record<string, Record<string, unknown>> | undefined,
): number | null {
  const gw = providerMetadata?.gateway;
  const raw = gw?.cost ?? gw?.totalCost;
  const n =
    typeof raw === "string" && raw.trim() !== ""
      ? Number(raw)
      : typeof raw === "number"
        ? raw
        : NaN;
  return Number.isFinite(n) ? n : null;
}

function fallbackCostUsd(model: string, tokens: Required<AiUsageTokens>): number {
  const pricing = pricingFor(model);
  if (!pricing) return 0;
  if (pricing.perSearchUsd !== undefined) {
    // One search per `perSearchDocs` documents; a rerank of nothing is still
    // one search as far as the provider is concerned.
    const searches = Math.max(1, Math.ceil(tokens.input / (pricing.perSearchDocs ?? 100)));
    return round6(searches * pricing.perSearchUsd);
  }
  // `input` is the whole prompt; the cache reads and writes inside it are
  // priced at their own rates, so only the remainder pays the base rate.
  const uncached = Math.max(0, tokens.input - tokens.cached - tokens.cacheWrite);
  const input = (uncached / 1_000_000) * pricing.inputPer1M;
  const output = (tokens.output / 1_000_000) * pricing.outputPer1M;
  const cached = (tokens.cached / 1_000_000) * (pricing.cachedPer1M ?? pricing.inputPer1M);
  const written = (tokens.cacheWrite / 1_000_000) * (pricing.cacheWritePer1M ?? pricing.inputPer1M);
  return round6(input + output + cached + written);
}

/**
 * What a call would cost at market price: the gateway's figure when it
 * reported one, else the table. For calls billed elsewhere (an org's own
 * key) that are recorded at cost 0 but still count against a budget.
 */
export function estimateCostUsd(
  model: string,
  tokens: AiUsageTokens,
  providerMetadata?: Record<string, Record<string, unknown>>,
): number {
  const fromGateway = gatewayCostUsd(providerMetadata);
  if (fromGateway !== null && fromGateway > 0) return fromGateway;
  return fallbackCostUsd(model, {
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    cached: tokens.cached ?? 0,
    cacheWrite: tokens.cacheWrite ?? 0,
  });
}

/** The ledger column is `numeric(12, 6)`; round here so the row says what was billed. */
function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Shape of the AI SDK's `usage` object on generateText/streamText/generateObject
 * results. `inputTokens` is the total prompt, cache reads and writes included
 * (`@ai-sdk/anthropic` builds it as `input + cache_creation + cache_read`).
 */
interface LanguageModelUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
  cachedInputTokens?: number;
}

/** Normalizes the AI SDK's usage shape into the tokens bag `recordAiUsageEvent` expects. */
export function tokensFromUsage(usage: LanguageModelUsageLike | undefined): AiUsageTokens {
  if (!usage) return {};
  return {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    cached: usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens ?? 0,
    cacheWrite: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
}

/**
 * Record one AI usage event. Best-effort: never throws, so callers can
 * fire-and-forget (`void recordAiUsageEvent(...).catch(() => {})` is
 * redundant here, but harmless).
 */
export async function recordAiUsageEvent(input: RecordAiUsageEventInput): Promise<void> {
  try {
    const tokens: Required<AiUsageTokens> = {
      input: input.tokens?.input ?? 0,
      output: input.tokens?.output ?? 0,
      cached: input.tokens?.cached ?? 0,
      cacheWrite: input.tokens?.cacheWrite ?? 0,
    };
    const providerCost =
      typeof input.providerCostUsd === "number" && Number.isFinite(input.providerCostUsd)
        ? input.providerCostUsd
        : gatewayCostUsd(input.providerMetadata);
    const usingProviderCost = providerCost !== null;
    const costUsd = usingProviderCost ? providerCost : fallbackCostUsd(input.model, tokens);
    // Three answers to "where did this price come from": the gateway said
    // so, our table said so, or nobody did. The third is the one the admin
    // panel flags; it must not be inferred from a cost of 0, because a
    // two-token embedding prices legitimately at 0 once rounded to 6 decimals.
    const costSource = usingProviderCost
      ? "provider"
      : pricingFor(input.model)
        ? "fallback"
        : "unpriced";

    const sb = getSupabaseAdmin();
    const row = {
      workspace_id: input.workspaceId,
      subject_user_id: input.subjectUserId ?? null,
      surface: input.surface,
      model: input.model,
      tokens_input: tokens.input,
      tokens_output: tokens.output,
      tokens_cached: tokens.cached,
      cost_usd: costUsd,
      cost_source: costSource,
      success: input.success ?? true,
      request_id: input.requestId ?? null,
      metadata: input.metadata ?? {},
    };
    const { error } = await sb
      .from("ai_usage_events")
      .upsert(row, { onConflict: "workspace_id,request_id", ignoreDuplicates: true });
    if (error) {
      log.warn("ai_usage.record_failed", { surface: input.surface, error: error.message });
    }
  } catch (err) {
    log.warn("ai_usage.record_failed", {
      surface: input.surface,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
