/**
 * Setup-time extraction proposal for an integration.
 *
 * During mandatory configuration the user writes a free-text objective
 * ("what should we pull out of your meetings?"). We answer with a short,
 * reviewable list — "given your goal, we'll aim to extract this for you" —
 * that the user can edit, trim or accept. Only the accepted list is
 * persisted (see meeting-records.ts).
 *
 * Two generators, same shape:
 *   - LLM path: reuses the app's AI Gateway infra (same pattern as
 *     src/lib/ingest/extract.ts) and meters usage on the
 *     `integration_setup` surface (added in migration 0053).
 *   - Deterministic heuristic fallback when no gateway key is configured
 *     or the model call fails — keyword-matched against a small catalog,
 *     so the setup flow never dead-ends.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { aiConfigured, languageModel } from "@/lib/ai/provider";
import { extractModel, extractProviderOptions } from "@/lib/ai/models";
import { log } from "@bcontext-dev/contract/log";
import { recordAiUsageEvent, tokensFromUsage } from "@/lib/telemetry/ai-usage";

export interface ExtractionItem {
  id: string;
  label: string;
  detail: string;
}

export interface ExtractionProposal {
  items: ExtractionItem[];
  /** "llm" when the gateway produced it; "heuristic" for the fallback. */
  source: "llm" | "heuristic";
}

const PROPOSAL_MODEL = "anthropic/claude-haiku-4-5";

const ProposalSchema = z.object({
  items: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        detail: z.string().min(1).max(200),
      }),
    )
    .min(2)
    .max(8),
});

const SYSTEM_PROMPT = `You configure an integration that ingests meeting recordings into a typed knowledge graph (kinds: decision, task, bug, adr, doc).
The user describes what they want to get out of their meetings. Reply with 3-6 concrete extraction targets we will look for in every transcript.
Rules:
- Each item: a short label (a noun phrase) and one sentence of detail describing exactly what will be captured.
- Ground every item in the user's goal; do not invent themes the user didn't imply. Generic staples (decisions, action items) are allowed when they clearly serve the goal.
- Match the user's language.
- If the user asked for changes to a previous proposal, apply them.`;

const slug = (label: string, index: number) =>
  `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "item"}-${index}`;

/** Keyword-matched catalog for the deterministic fallback. */
const HEURISTIC_CATALOG: { keywords: RegExp; label: string; detail: string }[] = [
  {
    keywords: /decision|decid|acuerd|agree|resol/i,
    label: "Decisions",
    detail: "Explicit decisions made during the meeting, with their context and consequences.",
  },
  {
    keywords: /action|task|tarea|todo|next step|siguiente|owner|assign/i,
    label: "Action items",
    detail: "Tasks agreed in the meeting, with owner and due date when mentioned.",
  },
  {
    keywords: /block|bloque|risk|riesgo|problem|issue|impedi/i,
    label: "Blockers & risks",
    detail: "Anything flagged as blocking progress or as a risk to watch.",
  },
  {
    keywords: /deadline|fecha|date|plazo|milestone|hito|schedule/i,
    label: "Deadlines & milestones",
    detail: "Dates, deadlines and milestones committed to during the conversation.",
  },
  {
    keywords: /customer|client|user|usuario|feedback|churn|deal|venta|sales/i,
    label: "Customer signals",
    detail: "Customer feedback, objections and commitments mentioned in the meeting.",
  },
  {
    keywords: /bug|error|fallo|incident|regress/i,
    label: "Bugs & incidents",
    detail: "Defects or incidents discussed, with reproduction context when available.",
  },
  {
    keywords: /metric|kpi|número|number|revenue|coste|cost|budget|presupuesto/i,
    label: "Metrics & numbers",
    detail: "Concrete figures quoted in the meeting (metrics, costs, targets).",
  },
  {
    keywords: /architect|technical|técnic|design|diseño|adr|stack/i,
    label: "Technical direction",
    detail: "Architecture and technical-design positions worth keeping as ADRs.",
  },
];

const HEURISTIC_BASELINE: { label: string; detail: string }[] = [
  {
    label: "Decisions",
    detail: "Explicit decisions made during the meeting, with their context and consequences.",
  },
  {
    label: "Action items",
    detail: "Tasks agreed in the meeting, with owner and due date when mentioned.",
  },
];

/**
 * Deterministic proposal: catalog entries whose keywords appear in the
 * objective, padded with the baseline (decisions + action items) so the
 * list never comes back empty. Pure — safe for tests.
 */
function heuristicExtractionProposal(objective: string): ExtractionItem[] {
  const matched = HEURISTIC_CATALOG.filter((entry) => entry.keywords.test(objective));
  const merged = [...matched.map(({ label, detail }) => ({ label, detail }))];
  for (const base of HEURISTIC_BASELINE) {
    if (!merged.some((item) => item.label === base.label)) merged.push(base);
  }
  return merged
    .slice(0, 6)
    .map((item, index) => ({ id: slug(item.label, index), ...item }));
}

/**
 * Generate the proposal. Uses the AI Gateway when configured; falls back
 * to the heuristic otherwise (never throws for a model failure).
 */
export async function generateExtractionProposal(input: {
  workspaceId: string;
  objective: string;
  /** "Ask for changes" text from the review step, if any. */
  feedback?: string;
  /** The items shown when feedback was written, so the model can revise. */
  previousItems?: Pick<ExtractionItem, "label" | "detail">[];
}): Promise<ExtractionProposal> {
  if (!aiConfigured()) {
    return { items: heuristicExtractionProposal(input.objective), source: "heuristic" };
  }

  const model = extractModel(PROPOSAL_MODEL);
  const prompt = [
    `User goal for the "Meeting records" integration:\n${input.objective}`,
    input.previousItems?.length
      ? `Previous proposal:\n${input.previousItems
          .map((item) => `- ${item.label}: ${item.detail}`)
          .join("\n")}`
      : null,
    input.feedback ? `Requested changes:\n${input.feedback}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const result = await generateObject({
      model: languageModel(model),
      providerOptions: extractProviderOptions(model),
      system: SYSTEM_PROMPT,
      prompt,
      schema: ProposalSchema,
    });

    void recordAiUsageEvent({
      workspaceId: input.workspaceId,
      surface: "integration_setup",
      model,
      tokens: tokensFromUsage(result.usage),
      metadata: { integration: "meeting-records" },
    });

    return {
      items: result.object.items.map((item, index) => ({
        id: slug(item.label, index),
        label: item.label,
        detail: item.detail,
      })),
      source: "llm",
    };
  } catch (err) {
    log.warn("integration_setup.proposal.model_error", {
      model,
      error: err instanceof Error ? err.message : String(err),
    });
    return { items: heuristicExtractionProposal(input.objective), source: "heuristic" };
  }
}
