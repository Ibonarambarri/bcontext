/**
 * `ask_nexo` — the voice of the living memory for other agents.
 *
 * `ask_rag` stays the primitive: retrieval → rerank → cited synthesis. This
 * layer answers the question an agent actually has — "what is true NOW, how
 * sure are we, and what is still moving?" — by wrapping that primitive with
 * the signals NEXO already keeps:
 *
 *   freshness        stale / superseded annotations on the cited hits
 *   conflicts        open `nexo_conflicts` rows touching the cited nodes
 *   signals_pending  ingest candidates still waiting (the graph may change)
 *   knowledge_gaps / suggested_actions  what the memory cannot answer yet
 *
 * Modes. `fast` is today's ask_rag path with the extra fields filled from
 * what is already known. `deep` additionally walks the typed relations of
 * the top hits one level (blocked_by / supersedes / references), cites the
 * superseding node when a hit is superseded, and asks the model for gaps and
 * actions. `auto` picks deep when the question asks for reasons or history
 * or when the top hit is no longer current, and says why in `mode_reason`.
 *
 * Invariants. Identity and grants come from the caller's storage — the
 * permission boundary is applied inside `retrieveScoped` before rerank and
 * before anything reaches a model, and every node fetched here goes through
 * the same scoped storage (out of reach reads as not found). Every claim is
 * cited; the model is told to label inference as inference. Without an AI
 * gateway the tool degrades explicitly: retrieval-only shape, `answer: null`,
 * and a note saying so — the citations, freshness and signals stay
 * authoritative.
 */
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { aiConfigured, languageModel } from "@/lib/ai/provider";
import { chatModel, DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
import { log } from "@bcontext-dev/contract/log";
import type { NodeEdge, NodeKind } from "@bcontext-dev/contract/types";
import type { ViewPrincipal } from "@bcontext-dev/contract/views/types";
import type { NexoConflict } from "@bcontext-dev/contract/nexo/conflicts";
import { refForHit, retrieveScoped, type RagHit } from "@/lib/rag";
import { RetrievalScopeSchema, type RetrievalScopeMetadata } from "@/lib/rag/scope";
import type { Storage, StorageBackend } from "@/lib/storage";
import { recordAiUsageEvent, tokensFromUsage } from "@/lib/telemetry/ai-usage";

const ASK_NEXO_MODES = ["fast", "deep", "auto"] as const;
export type AskNexoMode = (typeof ASK_NEXO_MODES)[number];
export type AskNexoEffectiveMode = Exclude<AskNexoMode, "auto">;

export const AskNexoInput = z.object({
  question: z.string().min(1).max(2000),
  mode: z.enum(ASK_NEXO_MODES).default("auto"),
  scope: RetrievalScopeSchema.optional(),
  k: z.number().int().min(1).max(20).default(6),
  // brief = one short paragraph; markdown = the default cited answer.
  format: z.enum(["markdown", "brief"]).default("markdown"),
}).strict();
export type AskNexoInputType = z.infer<typeof AskNexoInput>;

/** Relations walked one level from the top hits in deep mode. */
const DEEP_RELATIONS = ["blocked_by", "supersedes", "references"] as const;
/** How many of the top hit nodes get their relations walked. */
const DEEP_TOP_NODES = 3;
/** Ceiling on nodes added by the relation walk, so deep stays bounded. */
const DEEP_MAX_RELATED = 8;
const CONTEXT_CHARS = 1500;
const SNIPPET_CHARS = 480;
const DEFAULT_MODEL = DEFAULT_CHAT_MODEL;

/**
 * Cues that the caller wants reasons or history, which retrieval alone
 * answers badly: the "why" of a decision lives in the relations and in what
 * it superseded, not in the paragraph that ranked first.
 */
const WORD = "[\\wáéíóúñ]";
const DEEP_CUES = new RegExp(
  `(?:^|[^${WORD.slice(1, -1)}])(why|por\\s?qu[eé]|porqu[eé]|decid${WORD}*|histor${WORD}*|cambi${WORD}*|changed?)(?!${WORD})`,
  "i",
);

export type ConfidenceLevel = "low" | "medium" | "high";

export interface NexoCitation {
  n: number;
  node_id: string;
  title: string;
  kind: NodeKind;
  block_id: string | null;
  /** Paste-ready anchor: `/n/<id>` or `/n/<id>#<block>`. */
  ref: string;
  score: number | null;
  /** How this node entered the answer. */
  via: "retrieval" | "supersedes" | "relation";
  /** Set on `relation` citations: the edge that brought the node in. */
  relation?: { type: string; from_node: string; to_node: string };
  stale?: boolean;
  superseded_by?: string | null;
  expanded?: boolean;
  expansion_scope?: "inside_scope" | "outside_scope";
  snippet: string | null;
}

export interface NexoFreshness {
  status: "current" | "stale" | "superseded" | "unknown";
  stale_count: number;
  superseded_count: number;
  /** Whether edit-age staleness was annotated on this backend. */
  staleness_signal: "annotated" | "unavailable";
  note?: string;
}

export interface NexoSuggestedAction {
  action: string;
  node_id?: string;
  conflict_id?: string;
  reason: string;
}

export interface NexoConflictSummary {
  id: string;
  kind: NexoConflict["kind"];
  summary: string;
  related_node_ids: string[];
  created_at: string;
}

export interface AskNexoResult {
  question: string;
  mode_requested: AskNexoMode;
  mode_effective: AskNexoEffectiveMode;
  mode_reason: string;
  answer: string | null;
  answer_note?: string;
  citations: NexoCitation[];
  effective_scope: RetrievalScopeMetadata;
  confidence: ConfidenceLevel;
  confidence_reason: string;
  freshness: NexoFreshness;
  conflicts: NexoConflictSummary[];
  knowledge_gaps: string[];
  suggested_actions: NexoSuggestedAction[];
  /** Ingest candidates still waiting: the graph may still change under this answer. */
  signals_pending: number;
  /** Typed edges among the cited nodes (deep only; empty in fast). */
  relations: Array<{ from_node: string; to_node: string; relation: string }>;
}

/**
 * The two signal sources that live outside the storage abstraction. They are
 * injected so the tool can be exercised end to end on the demo backend, and
 * so a signal outage degrades to "none known" instead of failing the answer.
 */
export interface NexoSignals {
  listOpenConflicts(): Promise<NexoConflict[]>;
  countPendingSignals(): Promise<number>;
}

export interface AskNexoDeps {
  /** The caller's storage — already narrowed to its grant. Never a system one. */
  storage: Storage;
  workspaceRef: string;
  workspaceId: string;
  viewPrincipal?: ViewPrincipal;
  subjectUserId?: string | null;
  signals: NexoSignals;
  /** Record model calls in `ai_usage_events` (persisted workspaces only). */
  meter?: boolean;
  model?: string;
}

/** Default signal sources per backend. */
export function resolveNexoSignals(backend: StorageBackend, workspaceId: string): NexoSignals {
  if (backend === "supabase") {
    return {
      async listOpenConflicts() {
        const { listConflicts } = await import("@/lib/nexo/conflicts");
        return listConflicts(workspaceId, { status: "open" });
      },
      async countPendingSignals() {
        const { countCandidates } = await import("@/lib/ingest/candidates");
        return countCandidates(workspaceId, { status: "pending" });
      },
    };
  }
  return {
    // The demo backend has no conflict store: none known, said as such.
    async listOpenConflicts() {
      return [];
    },
    async countPendingSignals() {
      const { listDemoCandidates } = await import("@/lib/ingest/demo-candidates");
      return listDemoCandidates(workspaceId, { status: "pending" }).length;
    },
  };
}

/** Which route `auto` takes, and the one-line reason the caller gets back. */
export function pickMode(
  requested: AskNexoMode,
  question: string,
  top: Pick<RagHit, "stale" | "superseded_by"> | undefined,
): { effective: AskNexoEffectiveMode; reason: string } {
  if (requested !== "auto") return { effective: requested, reason: `mode ${requested} requested` };
  const cue = question.match(DEEP_CUES)?.[1];
  if (cue) return { effective: "deep", reason: `question asks for reasons or history ("${cue}")` };
  if (top?.superseded_by) return { effective: "deep", reason: "top hit is superseded — following the supersedes edge" };
  if (top?.stale) return { effective: "deep", reason: "top hit is stale — checking its relations for something current" };
  return { effective: "fast", reason: "no history cue and the top hit is current" };
}

function supersederOf(edges: NodeEdge[], nodeId: string): string | null {
  // First one wins, like `annotateStaleness`; several successors are a data
  // quality problem, not something to arbitrate here.
  const edge = edges.find((e) => e.relation === "supersedes" && e.to_node === nodeId);
  return edge ? edge.from_node : null;
}

interface ContextEntry {
  citation: NexoCitation;
  content: string;
}

/** Entry point behind the `ask_nexo` tool and the REST route; modes and invariants above. */
export async function askNexo(input: AskNexoInputType, deps: AskNexoDeps): Promise<AskNexoResult> {
  const { storage } = deps;
  const retrieval = await retrieveScoped(deps.workspaceRef, input.question, {
    k: input.k,
    scope: input.scope,
    storage,
    viewPrincipal: deps.viewPrincipal,
  });

  // `superseded_by` is undefined when staleness annotation did not run (the
  // keyword/demo path); the edges say the same thing and are cheap to read
  // through the caller's storage, which also keeps them inside the reach.
  const annotationsRan = retrieval.hits.some((h) => h.superseded_by !== undefined);
  const needEdges = input.mode !== "fast" || !annotationsRan;
  const edges: NodeEdge[] = needEdges
    ? await storage.listEdges().catch((err: unknown) => {
        log.warn("nexo.ask.edges_failed", { error: err instanceof Error ? err.message : String(err) });
        return [] as NodeEdge[];
      })
    : [];
  const hits: RagHit[] = retrieval.hits.map((h) =>
    h.superseded_by === undefined ? { ...h, superseded_by: supersederOf(edges, h.node_id) } : h,
  );

  const mode = pickMode(input.mode, input.question, hits[0]);

  // ---- Citations: hits first, then what deep adds ------------------------
  const entries: ContextEntry[] = hits.map((h, i) => ({
    citation: {
      n: i + 1,
      node_id: h.node_id,
      title: h.title,
      kind: h.kind,
      block_id: h.block_id,
      ref: refForHit(h),
      score: h.similarity,
      via: "retrieval",
      ...((h as { expanded?: boolean }).expanded ? { expanded: true } : {}),
      ...(h.expansion_scope ? { expansion_scope: h.expansion_scope } : {}),
      ...(h.stale ? { stale: true } : {}),
      ...(h.superseded_by ? { superseded_by: h.superseded_by } : {}),
      snippet: h.content?.slice(0, SNIPPET_CHARS) ?? null,
    },
    content: h.content ?? "",
  }));
  const cited = new Set(hits.map((h) => h.node_id));
  const relations: AskNexoResult["relations"] = [];

  const addNode = async (
    id: string,
    via: NexoCitation["via"],
    relation?: NexoCitation["relation"],
  ): Promise<boolean> => {
    if (cited.has(id)) return true;
    // Scoped storage answers "not found" for anything outside the reach, so
    // a relation can never smuggle a node the caller may not read.
    const node = await storage.getNode(id).catch(() => null);
    if (!node) return false;
    cited.add(id);
    entries.push({
      citation: {
        n: entries.length + 1,
        node_id: node.id,
        title: node.title,
        kind: node.kind,
        block_id: null,
        ref: refForHit({ node_id: node.id, block_id: null }),
        score: null,
        via,
        ...(relation ? { relation } : {}),
        ...(via === "relation" && supersederOf(edges, node.id)
          ? { superseded_by: supersederOf(edges, node.id) }
          : {}),
        snippet: node.content_md.slice(0, SNIPPET_CHARS) || null,
      },
      content: node.content_md,
    });
    return true;
  };

  if (mode.effective === "deep") {
    // 1. A superseded hit is still cited (never hidden), but the node that
    //    replaced it is what the caller actually needs.
    for (const h of hits) {
      if (h.superseded_by) {
        const ok = await addNode(h.superseded_by, "supersedes", {
          type: "supersedes",
          from_node: h.superseded_by,
          to_node: h.node_id,
        });
        if (ok) relations.push({ from_node: h.superseded_by, to_node: h.node_id, relation: "supersedes" });
      }
    }
    // 2. One level of typed relations around the top hits.
    const topNodes = Array.from(new Set(hits.filter((h) => !(h as { expanded?: boolean }).expanded).map((h) => h.node_id))).slice(0, DEEP_TOP_NODES);
    const topSet = new Set(topNodes);
    let added = 0;
    for (const e of edges) {
      if (!(DEEP_RELATIONS as readonly string[]).includes(e.relation)) continue;
      const touches = topSet.has(e.from_node) || topSet.has(e.to_node);
      if (!touches) continue;
      const other = topSet.has(e.from_node) ? e.to_node : e.from_node;
      const alreadyCited = cited.has(other);
      if (!alreadyCited && added >= DEEP_MAX_RELATED) continue;
      const ok = await addNode(other, "relation", { type: e.relation, from_node: e.from_node, to_node: e.to_node });
      if (!ok) continue;
      if (!alreadyCited) added += 1;
      if (!relations.some((r) => r.from_node === e.from_node && r.to_node === e.to_node && r.relation === e.relation)) {
        relations.push({ from_node: e.from_node, to_node: e.to_node, relation: e.relation });
      }
    }
  }

  // ---- Signals: conflicts + pending, in parallel, each best-effort --------
  const [openConflicts, pending] = await Promise.all([
    deps.signals.listOpenConflicts().catch((err: unknown) => {
      log.warn("nexo.ask.conflicts_failed", { error: err instanceof Error ? err.message : String(err) });
      return [] as NexoConflict[];
    }),
    deps.signals.countPendingSignals().catch((err: unknown) => {
      log.warn("nexo.ask.pending_failed", { error: err instanceof Error ? err.message : String(err) });
      return 0;
    }),
  ]);
  const conflicts: NexoConflictSummary[] = openConflicts
    .filter((c) => (c.related_node_ids ?? []).some((id) => cited.has(id)))
    .map((c) => ({
      id: c.id,
      kind: c.kind,
      summary: c.summary,
      related_node_ids: (c.related_node_ids ?? []).filter((id) => cited.has(id)),
      created_at: c.created_at,
    }));

  // ---- Freshness ------------------------------------------------------------
  const retrievalCitations = entries.filter((e) => e.citation.via === "retrieval").map((e) => e.citation);
  const staleCount = retrievalCitations.filter((c) => c.stale).length;
  const supersededCount = retrievalCitations.filter((c) => c.superseded_by).length;
  const top = retrievalCitations[0];
  const freshness: NexoFreshness = {
    status: !top ? "unknown" : top.superseded_by ? "superseded" : top.stale ? "stale" : "current",
    stale_count: staleCount,
    superseded_count: supersededCount,
    staleness_signal: annotationsRan ? "annotated" : "unavailable",
    ...(annotationsRan
      ? {}
      : { note: "edit-age staleness is not annotated on this backend; only supersedes edges were checked" }),
  };

  // ---- Deterministic actions (no model needed) -----------------------------
  const actions: NexoSuggestedAction[] = [];
  for (const c of retrievalCitations) {
    if (c.superseded_by) {
      actions.push({
        action: "read_superseding_node",
        node_id: c.superseded_by,
        reason: `"${c.title}" (${c.ref}) is superseded — the current truth is in /n/${c.superseded_by}`,
      });
    }
  }
  for (const c of conflicts) {
    actions.push({ action: "resolve_conflict", conflict_id: c.id, reason: c.summary });
  }
  if (pending > 0) {
    actions.push({
      action: "re_ask_after_ingest",
      reason: `${pending} ingest signal${pending === 1 ? "" : "s"} still pending — the answer may change once they land`,
    });
  }
  if (hits.length === 0) {
    actions.push({ action: "widen_scope", reason: "nothing matched inside the effective scope" });
  }

  // ---- Synthesis -------------------------------------------------------------
  let answer: string | null = null;
  let answerNote: string | undefined;
  let gaps: string[] = [];
  const aiReady = aiConfigured();
  if (hits.length === 0) {
    answerNote = "no hits inside the effective scope — nothing to answer from";
  } else if (!aiReady) {
    answerNote =
      "no AI model configured (AI_GATEWAY_API_KEY or OPENAI_BASE_URL) — retrieval-only: answer is null, citations, freshness, conflicts and signals_pending are still authoritative";
  } else {
    const model = chatModel(deps.model);
    const context = entries
      .map(
        ({ citation: c, content }) =>
          `[${c.n}] ${c.kind.toUpperCase()} · ${c.title} (${c.ref})${c.superseded_by ? ` — SUPERSEDED by /n/${c.superseded_by}` : ""}${c.stale ? " — STALE" : ""}${c.relation ? ` — via ${c.relation.type}` : ""}\n${content.trim().slice(0, CONTEXT_CHARS)}`,
      )
      .join("\n\n---\n\n");
    const conflictLines = conflicts.length
      ? `\n\nOpen conflicts touching the context:\n${conflicts.map((c) => `- (${c.kind}) ${c.summary}`).join("\n")}`
      : "";
    const style =
      input.format === "brief" ? "Answer in ONE short paragraph." : "Be concise (under 250 words).";
    const system = [
      "You are NEXO, the memory of this workspace, answering another agent.",
      "Answer strictly from the numbered context blocks. Cite every factual claim inline with its [N] marker.",
      "Never present an inference as a fact: anything you deduce rather than read must be prefixed with 'Inference:' and still point at the blocks it rests on.",
      "A block marked SUPERSEDED is history, not current truth — say what replaced it. A block marked STALE may be outdated; say so.",
      "If the context does not answer the question, say so plainly — never invent.",
      "Reply in the language of the question — never switch to English when the question is in Spanish. Every factual sentence ends with its [N] marker.",
      style,
    ].join(" ");
    const prompt = `Question: ${input.question}\n\nContext:\n${context}${conflictLines}`;
    try {
      if (mode.effective === "deep") {
        const result = await generateObject({
          model: languageModel(model),
          system:
            system +
            " Also list knowledge_gaps (what the memory would need to answer fully; empty when nothing is missing) and suggested_actions (concrete next steps for the asking agent, each with a reason and the node_id it concerns when there is one).",
          prompt,
          schema: DeepAnswerSchema,
        });
        answer = result.object.answer;
        gaps = result.object.knowledge_gaps.slice(0, 5);
        for (const a of result.object.suggested_actions.slice(0, 5)) {
          actions.push({
            action: a.action,
            ...(a.node_id && cited.has(a.node_id) ? { node_id: a.node_id } : {}),
            reason: a.reason,
          });
        }
        meter(deps, model, result.usage, mode.effective);
      } else {
        const result = await generateText({ model: languageModel(model), system, prompt });
        answer = result.text;
        meter(deps, model, result.usage, mode.effective);
      }
    } catch (err) {
      // Retrieval must never fail because synthesis did.
      answer = null;
      answerNote = "synthesis failed (model error) — citations, freshness and signals below are still authoritative";
      log.warn("nexo.ask.synthesis_failed", {
        workspace_id: deps.workspaceId,
        model,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const confidence = deriveConfidence({
    hits,
    conflicts: conflicts.length,
    answered: answer !== null,
    topSuperseded: Boolean(top?.superseded_by),
    topStale: Boolean(top?.stale),
  });

  return {
    question: input.question,
    mode_requested: input.mode,
    mode_effective: mode.effective,
    mode_reason: mode.reason,
    answer,
    ...(answerNote ? { answer_note: answerNote } : {}),
    citations: entries.map((e) => e.citation),
    effective_scope: retrieval.scope,
    confidence: confidence.level,
    confidence_reason: confidence.reason,
    freshness,
    conflicts,
    knowledge_gaps: gaps,
    suggested_actions: actions,
    signals_pending: pending,
    relations,
  };
}

const DeepAnswerSchema = z.object({
  answer: z.string().min(1),
  knowledge_gaps: z.array(z.string().min(1).max(300)).max(8),
  suggested_actions: z
    .array(
      z.object({
        action: z.string().min(1).max(120),
        node_id: z.string().optional(),
        reason: z.string().min(1).max(300),
      }),
    )
    .max(8),
});

function meter(
  deps: AskNexoDeps,
  model: string,
  usage: Parameters<typeof tokensFromUsage>[0],
  mode: AskNexoEffectiveMode,
): void {
  if (!deps.meter) return;
  void recordAiUsageEvent({
    workspaceId: deps.workspaceId,
    subjectUserId: deps.subjectUserId ?? null,
    surface: "ask_nexo",
    model,
    tokens: tokensFromUsage(usage),
    metadata: { mode },
  });
}

/**
 * low | medium | high from the rerank scores and their agreement, then
 * downgraded by what NEXO knows: a superseded or stale top hit, an open
 * conflict on the cited nodes, or no synthesis at all. Deterministic, so a
 * caller can reason about it; never a model's opinion of itself.
 */
export function deriveConfidence(input: {
  hits: Array<Pick<RagHit, "node_id" | "similarity">>;
  conflicts: number;
  answered: boolean;
  topSuperseded: boolean;
  topStale: boolean;
}): { level: ConfidenceLevel; reason: string } {
  const down = (level: ConfidenceLevel): ConfidenceLevel =>
    level === "high" ? "medium" : "low";
  const first = input.hits[0];
  if (!first) return { level: "low", reason: "no hits inside the effective scope" };
  const top = first.similarity;
  const supporters = new Set(input.hits.filter((h) => h.similarity >= Math.max(0.3, top * 0.5)).map((h) => h.node_id)).size;
  let level: ConfidenceLevel = top >= 0.6 ? "high" : top >= 0.3 ? "medium" : "low";
  const reasons = [`top score ${top.toFixed(2)}`, `${supporters} supporting node${supporters === 1 ? "" : "s"}`];
  if (level === "high" && supporters < 2) {
    level = "medium";
    reasons.push("single source");
  }
  if (input.topSuperseded) {
    level = down(level);
    reasons.push("top hit superseded");
  } else if (input.topStale) {
    level = down(level);
    reasons.push("top hit stale");
  }
  if (input.conflicts > 0) {
    level = down(level);
    reasons.push(`${input.conflicts} open conflict${input.conflicts === 1 ? "" : "s"}`);
  }
  if (!input.answered && level === "high") {
    level = "medium";
    reasons.push("retrieval only, no synthesis");
  }
  return { level, reason: reasons.join(", ") };
}
