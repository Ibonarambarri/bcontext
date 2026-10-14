/**
 * Meeting transcript → refined Markdown pipeline.
 *
 * Goal: turn a diarized transcript (which is verbose, conversational, and
 * full of filler) into a structured, RAG-friendly document. The refined
 * version is what lives in `nodes.content_md` and what the embeddings
 * pipeline sees; the raw transcript stays in `nodes.data.transcript_md`
 * so the UI can show it via the Refined / Transcript selector.
 *
 * Structure the model is asked to produce:
 *   # <title>
 *   _<TL;DR — 2 a 3 frases>_
 *
 *   **Participantes** — Alice, Bob, Carol · **Duración** — 32 min
 *
 *   ## Temas
 *   ### <h3 topic>
 *   - punto
 *   - punto
 *
 *   ## Decisiones
 *   - …
 *
 *   ## Action items
 *   - [ ] <task> — @asignee (due: …)
 *
 *   ## Preguntas abiertas
 *   - …
 *
 *   ## Citas clave
 *   - **Alice · 00:18** — "…"
 *
 * Hard rules in the prompt:
 *   - Preserve speaker attribution and timestamps on quotes.
 *   - Don't invent facts not present in the transcript.
 *   - Match the language of the transcript (don't translate).
 */
import { generateText } from "ai";
import { aiConfigured, languageModel } from "@/lib/ai/provider";
import { chatModel } from "@/lib/ai/models";
import { log } from "@bcontext-dev/contract/log";
import { tokensFromUsage, type AiUsageTokens } from "@/lib/telemetry/ai-usage";

export interface RefineInput {
  /** Raw diarized transcript as produced by `transcriptToMarkdown`. */
  transcriptMd: string;
  /** Optional human-readable meeting title (used in the prompt). */
  title?: string;
  /** Participants list to pin the model's "Participantes" header. */
  participants?: string[];
  /** Optional duration in seconds — surfaces in the refined header. */
  durationSec?: number | null;
  /** Override the gateway model. Defaults to `CHAT_MODEL` (`@/lib/ai/models`). */
  model?: string;
}

export interface RefineResult {
  refinedMd: string;
  model: string;
  /** For AI usage telemetry — the caller records the usage event with workspace id. */
  tokens: AiUsageTokens;
}

export class RefineError extends Error {
  code: "no_gateway_key" | "model_error" | "empty_response" | "input_too_short";
  constructor(code: RefineError["code"], message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "RefineError";
  }
}

/**
 * Minimum length below which we skip the LLM call entirely — refining
 * a 2-line transcript wastes tokens and produces noise.
 */
const MIN_TRANSCRIPT_CHARS = 200;

/**
 * Hard cap on transcript size we pass to the model. A 90-minute meeting
 * with diarization runs ~30-60 KB; this is generous but bounded so a
 * runaway recording doesn't blow the budget.
 */
const MAX_TRANSCRIPT_CHARS = 120_000;

export async function refineTranscript(input: RefineInput): Promise<RefineResult> {
  // Validate inputs before requiring the gateway key — this lets tests
  // (and CI environments) reject obviously-skip-worthy inputs without
  // needing a key configured.
  const transcript = (input.transcriptMd ?? "").trim();
  if (transcript.length < MIN_TRANSCRIPT_CHARS) {
    throw new RefineError(
      "input_too_short",
      `transcript too short to refine (${transcript.length} chars)`,
    );
  }
  if (!aiConfigured()) {
    throw new RefineError(
      "no_gateway_key",
      "no AI backend configured (AI_GATEWAY_API_KEY or OPENAI_BASE_URL) — meeting refine disabled",
    );
  }

  const model = chatModel(input.model);

  const prompt = buildRefinePrompt({
    transcriptMd:
      transcript.length > MAX_TRANSCRIPT_CHARS
        ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) +
          "\n\n[…transcripción truncada por longitud…]"
        : transcript,
    title: input.title,
    participants: input.participants ?? [],
    durationSec: input.durationSec ?? null,
  });

  let text: string;
  let tokens: AiUsageTokens;
  try {
    const result = await generateText({
      model: languageModel(model),
      system: SYSTEM_PROMPT,
      prompt,
    });
    text = (result.text ?? "").trim();
    tokens = tokensFromUsage(result.usage);
  } catch (err) {
    log.warn("meeting.refine.model_error", {
      model,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new RefineError(
      "model_error",
      err instanceof Error ? err.message : String(err),
    );
  }

  if (!text) {
    throw new RefineError("empty_response", `${model} returned empty text`);
  }
  return { refinedMd: text, model, tokens };
}

const SYSTEM_PROMPT = `You are a meeting note-taker for the Bcontext knowledge graph.
You receive a diarized transcript and produce a structured Markdown document.
Strict rules:
- Match the transcript's language. Do not translate.
- Never invent facts, decisions, or names that aren't in the transcript.
- Quotes must keep their **Speaker · timestamp** prefix exactly as in the transcript.
- Action items only when the transcript clearly assigns one. Owner defaults to the speaker who took it.
- Output Markdown only — no preamble, no closing remark, no triple-backtick fences around the whole thing.`;

interface PromptInput {
  transcriptMd: string;
  title?: string;
  participants: string[];
  durationSec: number | null;
}

export function buildRefinePrompt(input: PromptInput): string {
  const meta: string[] = [];
  if (input.title) meta.push(`Title: ${input.title}`);
  if (input.participants.length > 0)
    meta.push(`Participants: ${input.participants.join(", ")}`);
  if (input.durationSec != null && Number.isFinite(input.durationSec)) {
    const mins = Math.round(input.durationSec / 60);
    if (mins > 0) meta.push(`Duration: ${mins} min`);
  }

  const header = meta.length > 0 ? meta.join("\n") + "\n\n" : "";

  return `${header}Produce a Markdown document with EXACTLY these sections in this order, omitting any whose content would be empty:

# <title>
_<TL;DR — 2 to 3 sentences in the transcript's language>_

**Participantes** — <comma-separated names> · **Duración** — <X min>

## Temas
### <Topic 1>
- key point
- key point

### <Topic 2>
- …

## Decisiones
- <decision>

## Action items
- [ ] <task> — @owner (due: <when, if stated>)

## Preguntas abiertas
- <unresolved question>

## Citas clave
- **<Speaker> · <mm:ss>** — "<verbatim quote>"

---

Transcript (raw, diarized):

${input.transcriptMd}`;
}
