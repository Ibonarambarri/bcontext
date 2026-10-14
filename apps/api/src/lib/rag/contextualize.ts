/**
 * Contextual Retrieval (Anthropic, 2024).
 *
 * For each chunk in a node, ask the chat model for a short (50-100 token)
 * "where does this sit in the doc" prefix. The vector embedding and the BM25
 * index are computed against `${prefix}\n\n${chunk_content}`; the raw
 * `content` is preserved for UI snippets so users see the actual document
 * substring, not the synthesized prefix.
 *
 * Resilience: if the model call fails (rate-limit, gateway error, missing
 * key) we fall back to an empty prefix and emit a structured `warn`. The
 * write path is never blocked by contextualization.
 *
 * Reference: https://www.anthropic.com/news/contextual-retrieval
 */
import { generateText } from "ai";
import type { Chunk } from "@bcontext-dev/contract/rag/chunk";
import { log } from "@bcontext-dev/contract/log";
import { gatewayCostUsd, tokensFromUsage, type AiUsageTokens } from "@/lib/telemetry/ai-usage";
import { contextModel, DEFAULT_CONTEXT_MODEL } from "@/lib/ai/models";
import { aiConfigured, languageModel } from "@/lib/ai/provider";

export { DEFAULT_CONTEXT_MODEL };

/**
 * Hard cap on the reply. The prompt asks for ~100 tokens and
 * `normalizeContextPrefix` throws away anything past `PREFIX_CHAR_BUDGET`,
 * so every token past this line was paid for and discarded. Measured in
 * prod before the cap: ~63 output tokens per chunk on average, with a p95
 * several times that.
 */
const CONTEXT_MAX_OUTPUT_TOKENS = 160;

/**
 * Off unless `CONTEXTUAL_RETRIEVAL=1`. Measured on 2026-09-10 against the
 * bcontext workspace (489 chunks, 68 questions, scripts/ai-bench/
 * contextualize.mjs): embedding the bare chunk scored MRR 0.876; every
 * model's prefix scored the same or lower (Sonnet 4.6, the one prod ran,
 * 0.835), on short and on long nodes alike. The step was ~90% of the AI
 * bill and the slowest part of every write. Nodes here are short typed
 * notes with H2 blocks — the chunk already says where it sits. The code
 * stays for a workspace of long documents, where the technique was
 * designed to pay off; flip the flag and measure before keeping it.
 */
export function contextualRetrievalEnabled(): boolean {
  const v = process.env.CONTEXTUAL_RETRIEVAL?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

/**
 * Approximate cap on the LLM-generated prefix. The model is instructed to
 * stay under ~100 tokens; we additionally clamp to ~120 tokens of characters
 * as belt-and-suspenders so a runaway response can't blow up the embedding
 * input budget.
 */
const PREFIX_CHAR_BUDGET = 600;

/** First-N tokens of doc body that act as the "doc summary" anchor. */
const DOC_SUMMARY_CHAR_BUDGET = 800; // ~200 tokens

export interface ContextualizeNode {
  title: string;
  /** Full raw markdown body of the doc (without the title heading). */
  content_md: string;
}

export interface ContextualChunk extends Chunk {
  /** The LLM-generated prefix. Empty string when generation was skipped. */
  context_prefix: string;
  /** What we actually embed and BM25-index: prefix + "\n\n" + content. */
  embedding_input: string;
}

export interface ContextualizeOpts {
  /** Override the model. `CONTEXT_MODEL` env wins; then this; then Haiku. */
  model?: string;
  /**
   * Force the LLM step on or off. Defaults to `contextualRetrievalEnabled()`
   * (the `CONTEXTUAL_RETRIEVAL` env, off unless set).
   */
  enabled?: boolean;
  /**
   * AI usage telemetry hook: called once per chunk with that call's token
   * usage. Kept as a callback (rather than changing the return shape) so
   * `contextualizeChunks`/`generateChunkContext` stay drop-in for existing
   * callers — the aggregate is recorded as one `ai_usage_events` row per
   * node by the caller (`embedNode`), which is the only place that has a
   * `workspace_id` in scope.
   */
  onUsage?: (tokens: AiUsageTokens, costUsd: number | null) => void;
}

/**
 * Resolve which model generates prefixes: `CONTEXT_MODEL` (server env always
 * wins), otherwise an explicit opts value, otherwise the cheap default.
 * `CHAT_MODEL` no longer reaches this loop — see `src/lib/ai/models.ts`.
 */
export function resolveContextModel(override?: string | null): string {
  return contextModel(override);
}

/**
 * Pure helper — extract a stable "document summary" anchor for the prompt.
 * We just take the first N chars of the body, trimmed at the last
 * sentence/whitespace boundary so we don't cut mid-word. Cheap and
 * deterministic.
 */
export function deriveDocSummary(
  body: string,
  charBudget = DOC_SUMMARY_CHAR_BUDGET,
): string {
  const trimmed = body.trim();
  if (trimmed.length <= charBudget) return trimmed;
  const slice = trimmed.slice(0, charBudget);
  // Prefer a sentence boundary; fall back to a whitespace boundary.
  const lastStop = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
    slice.lastIndexOf("\n"),
  );
  if (lastStop > charBudget * 0.5) return slice.slice(0, lastStop + 1).trim();
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > 0) return slice.slice(0, lastSpace).trim();
  return slice.trim();
}

/**
 * Pure helper — build the prompt body sent to the chat model. Extracted so
 * tests can lock the wording without booting the AI SDK.
 *
 * Anchored on the document title and a short auto-summary so the model
 * doesn't hallucinate context from nowhere; explicit budget so the response
 * stays in the 50-100 token target.
 */
export function buildContextPrompt(args: {
  title: string;
  docSummary: string;
  chunkContent: string;
}): string {
  return [
    "<document_title>",
    args.title,
    "</document_title>",
    "<document_summary>",
    args.docSummary,
    "</document_summary>",
    "<chunk>",
    args.chunkContent,
    "</chunk>",
    "",
    "Write 1-2 short sentences (max ~100 tokens) that situate this chunk inside the document above.",
    "Include only context a retrieval-time reader would need to interpret the chunk; do not summarize the chunk itself, do not quote it, and do not include preamble like \"This chunk...\".",
    "Reply with the context only — no labels, no markdown, no quotes.",
  ].join("\n");
}

/**
 * Pure helper — sanitize / clamp an LLM response into a safe prefix.
 *  - Strip surrounding whitespace, code fences, and quote marks.
 *  - Collapse internal newlines so the prefix is a single line.
 *  - Clamp to PREFIX_CHAR_BUDGET (~120 tokens) so a malfunctioning model
 *    can't blow the embedding-input budget.
 */
export function normalizeContextPrefix(raw: string): string {
  let s = raw.trim();
  // Strip ```...``` fences if the model wrapped its reply.
  s = s.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "");
  // Strip surrounding quotes (straight or smart).
  s = s.replace(/^["'“‘]+|["'”’]+$/g, "");
  // Collapse newlines/tabs to spaces; squash runs of whitespace.
  s = s.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (s.length > PREFIX_CHAR_BUDGET) s = s.slice(0, PREFIX_CHAR_BUDGET).trim();
  return s;
}

/**
 * Pure helper — assemble the embedding-input string. Lives here (not inline
 * in `embed.ts`) so callers and tests share one definition. The exact
 * separator (`\n\n`) matters: BM25 tokenizers treat blank-line breaks as
 * sentence boundaries, which gives the prefix terms their own "sentence"
 * and slightly lifts their BM25 weight without skewing the vector input.
 */
export function combinePrefix(prefix: string, content: string): string {
  if (!prefix) return content;
  return `${prefix}\n\n${content}`;
}

/**
 * Generate a single context prefix. Resilient: returns `""` (with a structured
 * warn) on any failure, including a missing AI Gateway key.
 */
export async function generateChunkContext(args: {
  node: ContextualizeNode;
  chunk: Pick<Chunk, "content" | "index">;
  model?: string;
  onUsage?: (tokens: AiUsageTokens, costUsd: number | null) => void;
}): Promise<string> {
  if (!aiConfigured()) {
    return "";
  }
  const model = resolveContextModel(args.model);
  const prompt = buildContextPrompt({
    title: args.node.title,
    docSummary: deriveDocSummary(args.node.content_md),
    chunkContent: args.chunk.content,
  });
  try {
    const result = await generateText({
      model: languageModel(model),
      prompt,
      // ~100 tokens target + slack for tokenizer drift; see the constant.
      maxOutputTokens: CONTEXT_MAX_OUTPUT_TOKENS,
      temperature: 0.2,
    });
    args.onUsage?.(tokensFromUsage(result.usage), gatewayCostUsd(result.providerMetadata));
    return normalizeContextPrefix(result.text);
  } catch (err) {
    log.warn("rag.contextualize.failed", {
      chunk_index: args.chunk.index,
      model,
      error: { message: err instanceof Error ? err.message : String(err) },
    });
    return "";
  }
}

/**
 * Generate prefixes for every chunk in a node and return enriched chunks.
 *
 * Sequential — Anthropic's cookbook warns against parallelizing without
 * rate-limiting; for a single node (typically <30 chunks) this is fast
 * enough and avoids hammering the gateway. A future optimization could
 * cap concurrency at e.g. 4 once we have per-workspace rate limiting.
 */
export async function contextualizeChunks(
  node: ContextualizeNode,
  chunks: Chunk[],
  opts?: ContextualizeOpts,
): Promise<ContextualChunk[]> {
  const enabled = opts?.enabled ?? contextualRetrievalEnabled();
  if (!enabled || chunks.length === 0) {
    return chunks.map((c) => ({
      ...c,
      context_prefix: "",
      embedding_input: c.content,
    }));
  }
  const out: ContextualChunk[] = [];
  for (const chunk of chunks) {
    const prefix = await generateChunkContext({
      node,
      chunk,
      model: opts?.model,
      onUsage: opts?.onUsage,
    });
    out.push({
      ...chunk,
      context_prefix: prefix,
      embedding_input: combinePrefix(prefix, chunk.content),
    });
  }
  return out;
}
