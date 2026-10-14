/**
 * Generic, connector-agnostic signal -> candidate extractor.
 *
 * A source integration (GitHub, meetings, Slack, the Nango connectors)
 * hands this raw text plus a hint about where it came from; the
 * model classifies it into one of the four high-precision kinds and
 * produces H2-structured Markdown. The caller then passes the result to
 * `proposeCandidate()` — this module never touches the database.
 *
 * Non-goal: this does not decide WHICH signals are worth
 * extracting — that's each source integration's job (only high-precision
 * triggers, never a full firehose). This module only turns text that's
 * already been judged worth proposing into a typed candidate shape.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { aiConfigured, languageModel } from "@/lib/ai/provider";
import { extractModel, extractProviderOptions } from "@/lib/ai/models";
import { log } from "@bcontext-dev/contract/log";
import { recordAiUsageEvent, tokensFromUsage } from "@/lib/telemetry/ai-usage";
import type { IngestCandidateKind } from "./candidates";

export class ExtractCandidateError extends Error {
  code: "no_gateway_key" | "model_error";
  constructor(code: ExtractCandidateError["code"], message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "ExtractCandidateError";
  }
}

export interface ExtractedCandidate {
  kind: IngestCandidateKind;
  title: string;
  contentMd: string;
  confidence: number;
}

const ExtractionSchema = z.object({
  kind: z.enum(["decision", "task", "bug", "adr"]),
  title: z.string().min(1).max(200),
  content_md: z
    .string()
    .min(1)
    .describe(
      "Markdown body starting with an H2 heading (## Goal, ## Context, etc.), matching the source text's language.",
    ),
  confidence: z.number().min(0).max(1),
});

const SYSTEM_PROMPT = `You classify a raw signal (a PR description, a meeting excerpt, a Slack message...) into exactly one of four typed knowledge-graph node kinds: decision, task, bug, adr.
Strict rules:
- Only extract when the signal clearly represents one of the four kinds. Prefer a lower confidence score over inventing structure that isn't there.
- Never invent facts not present in the source text.
- Match the source text's language. Do not translate, and never switch to English when the source is in Spanish.
- Structure the body with H2 (##) sections appropriate to the kind (e.g. a decision gets "## Context" / "## Decision" / "## Consequences"; a task gets "## Objetivo" / "## Criterios de aceptación"; a bug gets "## Repro" / "## Impacto"; an adr gets "## Estado" / "## Contexto" / "## Decisión").
- confidence reflects how clearly the source text matches the chosen kind, not how important the content is.`;

/**
 * Extract a typed candidate from raw signal text. Resilient: throws
 * `ExtractCandidateError` on a missing gateway key or a model failure —
 * the caller decides whether to skip the signal or retry, this function
 * never returns a low-confidence guess silently.
 */
export async function extractCandidate(input: {
  workspaceId: string;
  rawText: string;
  sourceHint: string;
  model?: string;
}): Promise<ExtractedCandidate> {
  if (!aiConfigured()) {
    throw new ExtractCandidateError(
      "no_gateway_key",
      "no AI backend configured (AI_GATEWAY_API_KEY or OPENAI_BASE_URL) — ingest extraction disabled",
    );
  }

  const model = extractModel(input.model);

  try {
    const result = await generateObject({
      model: languageModel(model),
      providerOptions: extractProviderOptions(model),
      system: SYSTEM_PROMPT,
      prompt: `Source: ${input.sourceHint}\n\nRaw text:\n${input.rawText}`,
      schema: ExtractionSchema,
    });

    void recordAiUsageEvent({
      workspaceId: input.workspaceId,
      surface: "ingest_extract",
      model,
      tokens: tokensFromUsage(result.usage),
      providerMetadata: result.providerMetadata,
      metadata: { source_hint: input.sourceHint },
    });

    return {
      kind: result.object.kind,
      title: result.object.title,
      contentMd: result.object.content_md,
      confidence: result.object.confidence,
    };
  } catch (err) {
    log.warn("ingest.extract.model_error", {
      model,
      source_hint: input.sourceHint,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new ExtractCandidateError(
      "model_error",
      err instanceof Error ? err.message : String(err),
    );
  }
}
