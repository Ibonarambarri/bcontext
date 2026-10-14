/**
 * Autofix — rewrite a human-written node body into well-structured
 * Markdown WITHOUT losing information. The model may reorganize
 * (headings, bullets, checklists, fenced code, tables) but never adds,
 * drops or translates content. The caller (the node autofix route) shows
 * the result as an accept/reject diff; nothing is written here.
 *
 * Runs on the chat model of the instance's AI backend; without one
 * (`@/lib/ai/provider`) the feature is disabled rather than degraded.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { aiConfigured, languageModel } from "@/lib/ai/provider";
import { chatModel, DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
import { log } from "@bcontext-dev/contract/log";
import { tokensFromUsage, type AiUsageTokens } from "@/lib/telemetry/ai-usage";

export interface AutofixResult {
  rewrittenMd: string;
  model: string;
  /** How much of the note the model actually touched. */
  segments: { total: number; edited: number };
  /** For AI usage telemetry — the caller records the usage event with workspace/subject. */
  tokens: AiUsageTokens;
}

export class AutofixError extends Error {
  code: "no_gateway_key" | "model_error" | "empty_response" | "input_too_short";
  constructor(code: AutofixError["code"], message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "AutofixError";
  }
}

/**
 * Split a body into replaceable segments: optional YAML frontmatter (never
 * sent to the model), an optional preamble, then one segment per `## `
 * section — the same H2 blocks the rest of the product addresses. The
 * model edits whole segments or leaves them; reassembly keeps untouched
 * segments byte-for-byte identical.
 */
export function segmentMarkdown(md: string): { frontmatter: string; segments: string[] } {
  let rest = md;
  let frontmatter = "";
  const fm = /^---\n[\s\S]*?\n---\n?/.exec(rest);
  if (fm) {
    frontmatter = fm[0];
    rest = rest.slice(fm[0].length);
  }
  const lines = rest.split("\n");
  const segments: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && /^## /.test(line) && current.length > 0) {
      segments.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) segments.push(current.join("\n"));
  return { frontmatter, segments };
}

/** Reassemble, replacing only the segments the model edited. */
export function applySegmentEdits(
  frontmatter: string,
  segments: string[],
  edits: Array<{ index: number; markdown: string }>,
): string {
  const out = [...segments];
  for (const e of edits) {
    if (e.index >= 0 && e.index < out.length) out[e.index] = e.markdown;
  }
  return frontmatter + out.join("\n");
}

/** Below this there is nothing worth restructuring. */
const MIN_BODY_CHARS = 80;

/** Bounded input so a pathological node doesn't blow the budget. */
const MAX_BODY_CHARS = 60_000;

const DEFAULT_AUTOFIX_MODEL = DEFAULT_CHAT_MODEL;

const SYSTEM_PROMPT = `You restructure notes for the Bcontext knowledge graph.
You receive a node body split into NUMBERED SEGMENTS and return edits ONLY for segments that clearly benefit from restructuring.
Strict rules:
- A segment that is already well structured (or only needs a trivial tweak) gets NO edit — do not touch it, do not rephrase it.
- For segments you do edit: preserve EVERY piece of information. Never add facts, never drop facts, never summarize away detail.
- Match the note's language. Do not translate.
- Structure freely inside a segment: bullet lists for enumerations, "- [ ]" checklists for actionable items (keep existing "- [x]" states), fenced code blocks for code/commands/config, tables for tabular data, sub-headings (### or deeper).
- Never change a segment's opening "## " heading line unless it is malformed; never merge or split segments.
- Keep every link, node reference (like /n/<id> or [text](url)) and @mention exactly as written.
- Return the full replacement Markdown for each edited segment, including its heading line when it has one.`;

/**
 * Segments the body, asks the model for edits to the segments that need
 * restructuring, and reassembles. `AutofixError.code` tells the route which
 * HTTP status to answer with (short input and a missing key are not 500s).
 */
export async function autofixBody(input: {
  bodyMd: string;
  title?: string;
  model?: string;
}): Promise<AutofixResult> {
  const body = (input.bodyMd ?? "").trim();
  if (body.length < MIN_BODY_CHARS) {
    throw new AutofixError(
      "input_too_short",
      `node body too short to autofix (${body.length} chars)`,
    );
  }
  if (!aiConfigured()) {
    throw new AutofixError(
      "no_gateway_key",
      "no AI backend configured (AI_GATEWAY_API_KEY or OPENAI_BASE_URL) — autofix disabled",
    );
  }

  const model = chatModel(input.model);

  const clippedInput =
    body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body;
  const { frontmatter, segments } = segmentMarkdown(clippedInput);

  const numbered = segments
    .map((seg, i) => `[segment ${i}]\n${seg}`)
    .join("\n\n");
  const prompt =
    (input.title ? `Node title: ${input.title}\n\n` : "") +
    `Node body in ${segments.length} numbered segments:\n\n${numbered}`;

  let edits: Array<{ index: number; markdown: string }>;
  let tokens: AiUsageTokens;
  try {
    const result = await generateObject({
      model: languageModel(model),
      system: SYSTEM_PROMPT,
      prompt,
      schema: z.object({
        edits: z
          .array(
            z.object({
              index: z.number().int().min(0),
              markdown: z.string(),
            }),
          )
          .describe("Only the segments that need restructuring. Empty when the note is already well structured."),
      }),
    });
    edits = result.object.edits.filter((e) => e.index < segments.length);
    tokens = tokensFromUsage(result.usage);
  } catch (err) {
    log.warn("autofix.model_error", {
      model,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new AutofixError(
      "model_error",
      err instanceof Error ? err.message : String(err),
    );
  }

  const rewrittenMd = applySegmentEdits(frontmatter, segments, edits);
  return {
    rewrittenMd,
    model,
    segments: { total: segments.length, edited: new Set(edits.map((e) => e.index)).size },
    tokens,
  };
}
