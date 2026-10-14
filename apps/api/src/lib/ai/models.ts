/**
 * Which model each kind of call runs on.
 *
 * Three variables, three jobs — because one variable was doing all three.
 * `CHAT_MODEL` used to override every call site, so the "cheap default" the
 * contextualize and extract code declared never ran in production: every
 * per-chunk prefix and every nightly contradiction check went to the chat
 * model. Measured on 2026-09-10, that loop was ~90% of the AI bill.
 *
 *   CHAT_MODEL     interactive, quality-bearing answers a person or an agent
 *                  reads: Nexo chat, ask_nexo / ask_rag synthesis, skills,
 *                  autofix, meeting refine.
 *   CONTEXT_MODEL  the one-sentence Contextual Retrieval prefix generated per
 *                  chunk on every embed (src/lib/rag/contextualize.ts). High
 *                  volume, tiny output, nobody reads it.
 *   EXTRACT_MODEL  structured extraction and judging: ingest candidates,
 *                  batch extraction, conflict resolution, the nightly
 *                  contradiction sweep, integration proposals.
 *
 * Read at call time, like `src/lib/env.ts`, so tests can set them per case.
 * The ids are the backend's own names: "provider/model" on the AI Gateway,
 * whatever the server lists with `OPENAI_BASE_URL` (`src/lib/ai/provider.ts`).
 * The fallback pricing table in `src/lib/telemetry/ai-usage.ts` must know
 * any model these are pointed at, or the usage meter (`ai_usage_events`)
 * counts its calls at $0.
 */
import { aiBackend } from "./provider";

// Defaults come from scripts/ai-bench on 2026-09-10 (bcontext workspace):
//  - chat: Sonnet 5 scored 5.0/5.0 on cited answers where Sonnet 4.6 scored
//    4.88, at two thirds of the price ($2/$10 vs $3/$15). gpt-5-mini tied it
//    at 1/12 of the cost on single-shot synthesis but was not measured with
//    the 16 Nexo tools — the next experiment, not the default.
//  - context: Haiku only matters with CONTEXTUAL_RETRIEVAL=1 (off by default;
//    see src/lib/rag/contextualize.ts). gpt-5-nano matched it at 1/17 of
//    the price if the flag ever goes on.
//  - extract: DeepSeek V4 Flash on the hosts below scored 0.88-1.00 on the
//    contradiction judge, kind 0.88-1.00 on ingest extraction and 6/6 on a
//    tool-using turn across runs (scripts/ai-bench/deepseek.mjs) — the same
//    band as Sonnet 5 (0.88) and Gemini 3 Flash (0.94) with the same
//    prompts, 16 and 8 items being too few to separate them — at ~1/15 of
//    Sonnet 5 and ~1/3 of Gemini. Its weak spot is the serving layer, not
//    the model: Alibaba rejects structured output, Baseten takes 20s,
//    several hosts return no JSON at all, Fireworks was down twice in one
//    day, and whether the model reasons depends on the host. The surfaces
//    behind EXTRACT_MODEL are background jobs with retries, which is where
//    that trade is acceptable; Gemini 3 Flash is the first-party
//    alternative if the hosts misbehave.
export const DEFAULT_CHAT_MODEL = "anthropic/claude-sonnet-5";
export const DEFAULT_CONTEXT_MODEL = "anthropic/claude-haiku-4-5";
export const DEFAULT_EXTRACT_MODEL = "deepseek/deepseek-v4-flash";

/**
 * Gateway hosts allowed to serve open-weight extract models, in the
 * gateway's own routing order. Measured 2026-09-10 on DeepSeek V4 Flash
 * structured output: Azure ~1.5s, DeepInfra ~3s, Fireworks 2-10s (and down
 * twice that day); Baseten 12-22s; Alibaba a 400 on every `generateObject`;
 * DigitalOcean, Wafer and GMI Cloud no schema-valid JSON. Override with
 * `EXTRACT_PROVIDERS` (comma-separated gateway provider slugs).
 */
export const DEFAULT_EXTRACT_PROVIDERS = ["azure", "deepinfra", "fireworks"];

/** Models served by several third-party hosts, where pinning the hosts matters. */
const OPEN_WEIGHT_PREFIXES = ["deepseek/", "moonshotai/", "zai/", "alibaba/", "minimax/", "meta/", "mistral/"];

/**
 * `providerOptions` for an extract call: pins the serving hosts for
 * open-weight models and opts the request out of provider training.
 * Undefined for first-party models (Anthropic, Google, OpenAI), whose
 * routing the gateway already handles, and off the gateway.
 */
export function extractProviderOptions(model: string = extractModel()) {
  // Host pinning is a gateway feature; an OpenAI-compatible server serves
  // the model itself.
  if (aiBackend() !== "gateway") return undefined;
  if (!OPEN_WEIGHT_PREFIXES.some((p) => model.startsWith(p))) return undefined;
  const only = clean(process.env.EXTRACT_PROVIDERS)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? DEFAULT_EXTRACT_PROVIDERS;
  return { gateway: { only, disallowPromptTraining: true } };
}

function clean(v: string | undefined | null): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/** Interactive answers. Explicit override first, then `CHAT_MODEL`, then the default. */
export function chatModel(override?: string | null): string {
  return clean(override) ?? clean(process.env.CHAT_MODEL) ?? DEFAULT_CHAT_MODEL;
}

/**
 * Per-chunk context prefixes. The server variable wins over a caller
 * override (an operator pins it without redeploying), as it always did here.
 */
export function contextModel(override?: string | null): string {
  return clean(process.env.CONTEXT_MODEL) ?? clean(override) ?? DEFAULT_CONTEXT_MODEL;
}

/** Structured extraction and judging. Explicit override first, then `EXTRACT_MODEL`. */
export function extractModel(override?: string | null): string {
  return clean(override) ?? clean(process.env.EXTRACT_MODEL) ?? DEFAULT_EXTRACT_MODEL;
}
