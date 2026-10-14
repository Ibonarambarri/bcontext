/**
 * Batch extractor for the periodic integration sync.
 *
 * `extractCandidate` works signal by signal. A daily cadence must not be
 * "the same thing, later": it folds everything an integration fetched in
 * the period into FEW dense candidates — several Jira issues about one
 * migration become one task or one decision, not five. The user's
 * `ingest_guidance` ("what NEXO should learn from this integration") is the
 * lens: it decides what is worth a node at all.
 *
 * Pure with respect to storage: returns candidates + the evidence quotes
 * that back them. The caller (`src/lib/connectors/nango`) proposes them and
 * lets NEXO triage (auto-accept / conflict).
 */
import { generateObject } from "ai";
import { z } from "zod";
import { aiConfigured, languageModel } from "@/lib/ai/provider";
import { extractModel, extractProviderOptions } from "@/lib/ai/models";
import { log } from "@bcontext-dev/contract/log";
import { recordAiUsageEvent, tokensFromUsage, type AiUsageSurface } from "@/lib/telemetry/ai-usage";
import type { IngestCandidateKind } from "./candidates";
import { ExtractCandidateError } from "./extract";

/** One thing an integration fetched: a ticket, a page, a row, a thread. */
export interface IngestSignal {
  /** Stable id in the source system (used for provenance + dedupe). */
  external_id: string;
  title: string;
  /** Plain text, already flattened (no HTML/ADF). */
  text: string;
  url?: string;
  author?: string;
  /** ISO timestamp of the change. */
  at?: string;
  /** Free label the adapter attaches: "issue", "page", "ticket", "row". */
  kind_hint?: string;
}

export interface BatchEvidence {
  external_id: string;
  excerpt: string;
}

export interface BatchCandidate {
  kind: IngestCandidateKind;
  title: string;
  contentMd: string;
  confidence: number;
  evidence: BatchEvidence[];
}

export interface BatchExtractResult {
  candidates: BatchCandidate[];
  /** Signals the model judged irrelevant to the guidance. */
  skipped: number;
  model: string;
}

const MAX_SIGNALS = 40;
const MAX_TEXT_PER_SIGNAL = 1500;

const BatchSchema = z.object({
  candidates: z
    .array(
      z.object({
        kind: z.enum(["decision", "task", "bug", "adr"]),
        title: z.string().min(1).max(200),
        content_md: z
          .string()
          .min(1)
          .describe("Markdown body starting with H2 sections, in the signals' language."),
        confidence: z.number().min(0).max(1),
        evidence: z
          .array(
            z.object({
              external_id: z.string().min(1),
              excerpt: z.string().min(1).max(400).describe("Exact quote from that signal."),
            }),
          )
          .min(1),
      }),
    )
    .max(12),
  skipped: z.number().int().min(0),
});

const SYSTEM_PROMPT = `You are NEXO, the intelligence that turns what a company's tools produced in a period into durable knowledge for its knowledge graph.
You receive N signals fetched from one integration (tickets, pages, rows, threads) and the workspace owner's guidance about what they want to learn from this integration.
Produce FEW, DENSE candidates — the fewest nodes that capture what actually matters, never one node per signal:
- Merge signals about the same topic into one candidate.
- Only four kinds exist: decision (something was decided), task (something must be done and is not done), bug (something is broken), adr (an architectural/technical decision with alternatives and consequences).
- Respect the guidance strictly: if the guidance says "decisions", do not produce tasks unless a decision implies one and it is clearly stated.
- Never invent facts. Every candidate cites exact excerpts from the signals it was built from (external_id + verbatim excerpt).
- Match the signals' language. Do not translate, and never switch to English when the signals are in Spanish.
- Structure content_md with H2 (##) sections appropriate to the kind (decision: ## Context / ## Decision / ## Consequences; task: ## Goal / ## Acceptance criteria; bug: ## Repro / ## Impact; adr: ## Status / ## Context / ## Decision).
- confidence = how sure you are that this is a real, durable fact of the chosen kind (not how important it is). Below 0.5 means "I am guessing".
- skipped = how many signals you deliberately left out as noise or out of scope.`;

function trim(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Numbered, trimmed signal list the model sees; `[n]` indices are how it cites evidence. */
export function renderSignalsForPrompt(signals: IngestSignal[]): string {
  return signals
    .slice(0, MAX_SIGNALS)
    .map((s, i) => {
      const meta = [s.kind_hint, s.author ? `by ${s.author}` : null, s.at ?? null, s.url ?? null]
        .filter(Boolean)
        .join(" · ");
      return `### [${i + 1}] ${s.title}\nexternal_id: ${s.external_id}${meta ? `\n${meta}` : ""}\n\n${trim(s.text, MAX_TEXT_PER_SIGNAL)}`;
    })
    .join("\n\n");
}

/**
 * Fold a period's signals into candidates. Throws `ExtractCandidateError`
 * (`no_gateway_key` / `model_error`) like the single-signal extractor so
 * callers share one failure path.
 */
export async function extractBatch(input: {
  workspaceId: string;
  sourceHint: string;
  guidance: string | null;
  signals: IngestSignal[];
  model?: string;
  /** Who the model call is billed to in usage telemetry; defaults to the ingest surface. */
  usage?: { surface?: AiUsageSurface; metadata?: Record<string, unknown> };
}): Promise<BatchExtractResult> {
  if (input.signals.length === 0) {
    return { candidates: [], skipped: 0, model: extractModel(input.model) };
  }
  if (!aiConfigured()) {
    throw new ExtractCandidateError("no_gateway_key", "no AI backend configured (AI_GATEWAY_API_KEY or OPENAI_BASE_URL) — batch extraction disabled");
  }

  const model = extractModel(input.model);
  const guidance = input.guidance?.trim() || "Capture the decisions, tasks and bugs this integration reveals.";

  try {
    const result = await generateObject({
      model: languageModel(model),
      providerOptions: extractProviderOptions(model),
      system: SYSTEM_PROMPT,
      prompt: `Source: ${input.sourceHint}\nSignals in this batch: ${Math.min(input.signals.length, MAX_SIGNALS)}${
        input.signals.length > MAX_SIGNALS ? ` (of ${input.signals.length})` : ""
      }\n\nOwner's guidance for this integration:\n${guidance}\n\n## Signals\n\n${renderSignalsForPrompt(input.signals)}`,
      schema: BatchSchema,
    });

    void recordAiUsageEvent({
      workspaceId: input.workspaceId,
      surface: input.usage?.surface ?? "ingest_extract",
      model,
      tokens: tokensFromUsage(result.usage),
      providerMetadata: result.providerMetadata,
      metadata: { source_hint: input.sourceHint, batch: true, signals: input.signals.length, ...(input.usage?.metadata ?? {}) },
    });

    const known = new Set(input.signals.map((s) => s.external_id));
    return {
      model,
      skipped: result.object.skipped,
      candidates: result.object.candidates.map((c) => ({
        kind: c.kind,
        title: c.title,
        contentMd: c.content_md,
        confidence: c.confidence,
        // Drop citations to ids the model made up; keep the candidate if any survive.
        evidence: c.evidence.filter((e) => known.has(e.external_id)),
      })).filter((c) => c.evidence.length > 0),
    };
  } catch (err) {
    log.warn("ingest.batch_extract.model_error", {
      model,
      source_hint: input.sourceHint,
      signals: input.signals.length,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new ExtractCandidateError("model_error", err instanceof Error ? err.message : String(err));
  }
}

/** Stable candidate id for a batch: source + hash of the evidence ids it rests on. */
export function batchExternalId(kind: string, evidence: BatchEvidence[]): string {
  const ids = Array.from(new Set(evidence.map((e) => e.external_id))).sort();
  let hash = 0;
  for (const ch of ids.join("|")) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `batch:${kind}:${hash.toString(16)}:${ids[0] ?? "none"}`;
}
