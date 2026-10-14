/**
 * NEXO conflicts — data layer + the two LLM judgements around it.
 *
 *   openConflict / listConflicts / getConflict / dismissConflict
 *   detectContradiction(workspaceId, candidate)  → does the graph disagree?
 *   resolveConflict(storage, id, decision, user)  → human answer → node ops
 *
 * Writes go through the service-role client (RLS: members read, nobody
 * inserts from the client). Every LLM call is optional: without an AI
 * gateway key detection says "no contradiction" and resolution records the
 * decision without applying node operations — the product degrades to a
 * plain review list, it never blocks ingestion.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { aiConfigured, languageModel } from "@/lib/ai/provider";
import { extractModel, extractProviderOptions } from "@/lib/ai/models";
import { log } from "@bcontext-dev/contract/log";
import type {
  NexoConflict,
  NexoConflictEvidence,
  NexoConflictKind,
  NexoConflictRelatedNode,
  NexoConflictStatus,
  NexoResolution,
  NexoResolutionAction,
} from "@bcontext-dev/contract/nexo/conflicts";
import type { IngestCandidate } from "@bcontext-dev/contract/ingest";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { Storage } from "@/lib/storage";
import { appendBlock, listBlocks, replaceBlock, type BlockView } from "@/lib/blocks";
import { recordAiUsageEvent, tokensFromUsage } from "@/lib/telemetry/ai-usage";
import {
  acceptCandidate,
  dismissCandidate,
  getCandidate,
} from "@/lib/ingest/candidates";

export type {
  NexoConflict,
  NexoConflictEvidence,
  NexoConflictKind,
  NexoConflictRelatedNode,
  NexoConflictStatus,
  NexoResolution,
} from "@bcontext-dev/contract/nexo/conflicts";

export class NexoConflictError extends Error {
  constructor(
    public readonly code: "not_found" | "not_open",
    message: string,
  ) {
    super(message);
    this.name = "NexoConflictError";
  }
}

// -- Data layer -------------------------------------------------------------

export interface OpenConflictInput {
  workspaceId: string;
  kind: NexoConflictKind;
  summary: string;
  contextMd: string;
  evidence?: NexoConflictEvidence[];
  relatedNodeIds?: string[];
  candidateId?: string | null;
}

/**
 * Open a conflict. When it wraps a candidate that already has an open
 * conflict, refresh that row instead of stacking a duplicate (a redelivered
 * signal must not produce two rows).
 */
export async function openConflict(input: OpenConflictInput): Promise<NexoConflict> {
  const sb = getSupabaseAdmin();
  const payload = {
    workspace_id: input.workspaceId,
    kind: input.kind,
    summary: input.summary.slice(0, 400),
    context_md: input.contextMd,
    evidence: input.evidence ?? [],
    related_node_ids: input.relatedNodeIds ?? [],
    candidate_id: input.candidateId ?? null,
  };

  if (input.candidateId) {
    const { data: existing } = await sb
      .from("nexo_conflicts")
      .select("id")
      .eq("workspace_id", input.workspaceId)
      .eq("candidate_id", input.candidateId)
      .eq("status", "open")
      .maybeSingle();
    if (existing) {
      const { data, error } = await sb
        .from("nexo_conflicts")
        .update(payload)
        .eq("workspace_id", input.workspaceId)
        .eq("id", existing.id)
        .select("*")
        .single();
      if (error || !data) throw new Error(`openConflict(update): ${error?.message}`);
      return data as NexoConflict;
    }
  }

  const { data, error } = await sb
    .from("nexo_conflicts")
    .insert({ ...payload, status: "open" })
    .select("*")
    .single();
  if (error || !data) throw new Error(`openConflict: ${error?.message}`);
  return data as NexoConflict;
}

export async function listConflicts(
  workspaceId: string,
  opts: { status?: NexoConflictStatus; limit?: number } = {},
): Promise<NexoConflict[]> {
  const sb = getSupabaseAdmin();
  let query = sb
    .from("nexo_conflicts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 200);
  if (opts.status) query = query.eq("status", opts.status);
  const { data, error } = await query;
  if (error) throw new Error(`listConflicts: ${error.message}`);
  return (data ?? []) as NexoConflict[];
}

/** Workspace-scoped on purpose — the id comes from the caller. */
export async function getConflict(id: string, workspaceId: string): Promise<NexoConflict | null> {
  const sb = getSupabaseAdmin();
  const { data } = await sb
    .from("nexo_conflicts")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  return (data as NexoConflict | null) ?? null;
}

/** Title/kind cards for the conflict's related nodes; unreadable ones are skipped. */
export async function relatedNodes(
  storage: Storage,
  conflict: NexoConflict,
): Promise<NexoConflictRelatedNode[]> {
  const out: NexoConflictRelatedNode[] = [];
  for (const id of conflict.related_node_ids ?? []) {
    const node = await storage.getNode(id).catch(() => null);
    if (node) out.push({ id: node.id, title: node.title, kind: node.kind });
  }
  return out;
}

export async function dismissConflict(
  workspaceId: string,
  id: string,
  userId: string | null,
): Promise<NexoConflict> {
  const conflict = await getConflict(id, workspaceId);
  if (!conflict) throw new NexoConflictError("not_found", `conflict not found: ${id}`);
  if (conflict.status !== "open") throw new NexoConflictError("not_open", `conflict ${id} is ${conflict.status}`);
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("nexo_conflicts")
    .update({ status: "dismissed", resolved_by: userId, resolved_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .select("*")
    .single();
  if (error || !data) throw new Error(`dismissConflict: ${error?.message}`);
  // A dismissed doubt takes its candidate with it; a contradiction leaves
  // the candidate pending — dismissing means "no conflict", not "no fact".
  if (conflict.candidate_id && conflict.kind === "doubt") {
    await dismissCandidate(workspaceId, conflict.candidate_id, userId).catch(() => undefined);
  }
  return data as NexoConflict;
}

// -- Detection --------------------------------------------------------------

export interface ContradictionVerdict {
  contradiction: boolean;
  summary: string;
  contextMd: string;
  evidence: NexoConflictEvidence[];
  relatedNodeIds: string[];
}

const VerdictSchema = z.object({
  contradiction: z.boolean(),
  summary: z.string().min(1).max(300),
  context_md: z.string().min(1),
  node_ids: z.array(z.string()),
  excerpts: z.array(
    z.object({
      from: z.enum(["candidate", "node"]),
      node_id: z.string().optional(),
      excerpt: z.string().min(1).max(400),
    }),
  ),
});

const DETECT_PROMPT = `You compare a NEW candidate fact with EXISTING knowledge-graph nodes on the same topic.
A CONTRADICTION is when the candidate states something incompatible with an existing node AND does not itself say that things changed (no "we changed", "previously", "supersedes", "instead of", dates that explain the difference).
Not a contradiction: adding detail, a different topic, the same fact in other words, or an explicit update that acknowledges the previous state.
Answer in the language of the candidate. summary: one sentence a busy person reads in a list ("The candidate says X, but <node title> says Y."). context_md: both sides with the exact sentences, and why it matters. node_ids: the ids of the existing nodes involved (only from the ones given). excerpts: verbatim quotes from both sides.`;

/**
 * Ask the graph whether it disagrees with a candidate. Best effort: any
 * failure (no key, retrieval error, model error) returns "no contradiction"
 * and logs — detection must never block ingestion.
 */
export async function detectContradiction(
  workspaceId: string,
  candidate: Pick<IngestCandidate, "kind" | "title" | "content_md" | "source">,
  opts: { k?: number; minSimilarity?: number; model?: string } = {},
): Promise<ContradictionVerdict | null> {
  if (!aiConfigured()) return null;

  let hits: Array<{ node_id: string; title: string; kind: string; content: string; similarity: number }> = [];
  try {
    const { retrieveScoped } = await import("@/lib/rag");
    const query = `${candidate.title}\n${candidate.content_md.slice(0, 600)}`;
    const result = await retrieveScoped(workspaceId, query, { k: opts.k ?? 6 });
    const min = opts.minSimilarity ?? 0.45;
    hits = result.hits.filter((h) => h.similarity >= min && !h.superseded_by);
  } catch (err) {
    log.warn("nexo.detect.retrieval_failed", {
      workspace_id: workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (hits.length === 0) return null;

  // One block per node (the retriever returns chunks); cap the prompt.
  const byNode = new Map<string, { title: string; kind: string; content: string }>();
  for (const h of hits) {
    const prev = byNode.get(h.node_id);
    if (!prev) byNode.set(h.node_id, { title: h.title, kind: h.kind, content: h.content.slice(0, 1200) });
    else if (prev.content.length < 2400) prev.content += `\n…\n${h.content.slice(0, 1200)}`;
  }

  const model = extractModel(opts.model);
  try {
    const result = await generateObject({
      model: languageModel(model),
      providerOptions: extractProviderOptions(model),
      system: DETECT_PROMPT,
      prompt: `## Candidate (${candidate.kind}, from ${candidate.source})\n# ${candidate.title}\n${candidate.content_md.slice(0, 3000)}\n\n## Existing nodes\n${Array.from(
        byNode.entries(),
      )
        .map(([id, n]) => `### node_id: ${id} (${n.kind})\n# ${n.title}\n${n.content}`)
        .join("\n\n")}`,
      schema: VerdictSchema,
    });
    void recordAiUsageEvent({
      workspaceId,
      surface: "ingest_extract",
      model,
      tokens: tokensFromUsage(result.usage),
      metadata: { phase: "detect_contradiction", nodes: byNode.size },
    });
    const known = new Set(byNode.keys());
    const nodeIds = result.object.node_ids.filter((id) => known.has(id));
    return {
      contradiction: result.object.contradiction && nodeIds.length > 0,
      summary: result.object.summary,
      contextMd: result.object.context_md,
      relatedNodeIds: nodeIds,
      evidence: result.object.excerpts.map((e) => ({
        source: e.from === "candidate" ? candidate.source : "graph",
        ...(e.node_id && known.has(e.node_id) ? { url: `/n/${e.node_id}` } : {}),
        excerpt: e.excerpt,
      })),
    };
  } catch (err) {
    log.warn("nexo.detect.model_error", {
      workspace_id: workspaceId,
      model,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// -- Resolution -------------------------------------------------------------

const PlanSchema = z.object({
  summary: z.string().min(1).max(400),
  actions: z
    .array(
      z.object({
        op: z.enum([
          "accept_candidate",
          "accept_candidate_edited",
          "dismiss_candidate",
          "update_block",
          "append_block",
          "supersede_node",
          "create_decision",
          "no_change",
        ]),
        node_id: z.string().optional(),
        /** supersede_node without a candidate: the related node that replaces `node_id`. */
        superseded_by: z.string().optional(),
        block_id: z.string().optional(),
        heading: z.string().max(200).optional(),
        title: z.string().max(200).optional(),
        content_md: z
          .string()
          .optional()
          .describe("Candidate/decision body, or the full new body of ONE block for update_block/append_block."),
        note: z.string().max(300).optional(),
      }),
    )
    .max(6),
});

/**
 * A node body is never rewritten by the model: it edits one H2 block or adds
 * one. Blocks longer than this are shown as a stub and refused for
 * update_block, so a body the model never saw in full cannot be replaced by
 * a shorter one (that is how six nodes lost half their content once).
 */
const BLOCK_PROMPT_LIMIT = 6000;

const RESOLVE_PROMPT = `You are NEXO. A human answered a conflict you raised. Turn their decision into the minimal set of knowledge-graph operations, and nothing they did not ask for.
Existing nodes are given as H2 blocks (block_id + body). You never rewrite a node: you change ONE block or add ONE block.
Operations:
- accept_candidate: the candidate is right as written (needs the candidate).
- accept_candidate_edited: the candidate is right with changes — give the full corrected content_md (and title if it changes). Needs the candidate.
- dismiss_candidate: the candidate is wrong or noise.
- update_block: one block of an existing node must change — give node_id, block_id and the block's full new body in content_md (the heading is not part of the body; use heading only to rename). Never for a block marked [not editable].
- append_block: add a dated note or section to an existing node — give node_id, heading and content_md. Prefer this over update_block for "this is superseded / no longer applies / clarified on <date>" notes.
- supersede_node: one node replaces another. With a candidate: give node_id of the OLD node; the candidate is accepted and linked as superseding it. Without a candidate: give node_id of the OLD node and superseded_by = the node_id of the related node that wins; the link is created and a note is appended to the old node.
- create_decision: the human states a NEW decision that no node holds — give title + content_md (## Context / ## Decision / ## Consequences). Never to record that a conflict was resolved or that two nodes do not contradict: the resolution summary already says that.
- no_change: the human said to leave things as they are (explain in note).
Rules: never invent facts beyond the decision text and the evidence; keep the language of the decision; summary is one sentence for the audit trail.`;

/**
 * Applies a human's free-text decision to a conflict: the model maps it to
 * one of the actions in the prompt above (accept, edit one block, append a
 * note, supersede, new decision, no change), the action is executed through
 * the caller's storage, and the conflict is closed with the summary for the
 * audit trail. Existing nodes reach the model as full H2 blocks and are only
 * ever edited by block — the model never gets to hand back a whole body.
 */
export async function resolveConflict(
  storage: Storage,
  id: string,
  decision: string,
  userId: string | null,
  opts: { model?: string } = {},
): Promise<NexoConflict> {
  const workspaceId = storage.workspace.id;
  const conflict = await getConflict(id, workspaceId);
  if (!conflict) throw new NexoConflictError("not_found", `conflict not found: ${id}`);
  if (conflict.status !== "open") throw new NexoConflictError("not_open", `conflict ${id} is ${conflict.status}`);

  const candidate = conflict.candidate_id ? await getCandidate(conflict.candidate_id, workspaceId) : null;
  const nodes = await relatedNodes(storage, conflict);
  const nodeBodies: PlanNode[] = [];
  for (const n of nodes) {
    const full = await storage.getNode(n.id).catch(() => null);
    if (full) nodeBodies.push({ id: full.id, title: full.title, kind: full.kind, blocks: listBlocks(full.content_md) });
  }

  const plan = await planResolution({ workspaceId, conflict, candidate, nodes: nodeBodies, decision, model: opts.model });
  const applied = await applyPlan(storage, conflict, candidate, plan, userId);

  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("nexo_conflicts")
    .update({
      status: "resolved",
      decision_text: decision,
      resolution: applied,
      resolved_by: userId,
      resolved_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .select("*")
    .single();
  if (error || !data) throw new Error(`resolveConflict: ${error?.message}`);
  return data as NexoConflict;
}

type Plan = z.infer<typeof PlanSchema>;
type PlanNode = { id: string; title: string; kind: string; blocks: BlockView[] };

/** One node for the prompt: its blocks by id, long ones stubbed and flagged. */
function renderPlanNode(node: PlanNode): string {
  const blocks = node.blocks.map((block) => {
    const head = `#### block_id: ${block.block_id}${block.heading ? ` — ${block.heading}` : " (intro, no heading)"}`;
    if (block.body_md.length > BLOCK_PROMPT_LIMIT) {
      return `${head} [not editable: ${block.body_md.length} chars]\n${block.body_md.slice(0, 600)}…`;
    }
    return `${head}\n${block.body_md || "(empty)"}`;
  });
  return `### node_id: ${node.id} (${node.kind})\n# ${node.title}\n${blocks.join("\n\n")}`;
}

async function planResolution(input: {
  workspaceId: string;
  conflict: NexoConflict;
  candidate: IngestCandidate | null;
  nodes: PlanNode[];
  decision: string;
  model?: string;
}): Promise<Plan> {
  if (!aiConfigured()) {
    return {
      summary: "Decision recorded; no AI model configured, so no node operation was applied.",
      actions: [{ op: "no_change", note: "no AI backend configured (AI_GATEWAY_API_KEY or OPENAI_BASE_URL)" }],
    };
  }
  const model = extractModel(input.model);
  try {
    const result = await generateObject({
      model: languageModel(model),
      providerOptions: extractProviderOptions(model),
      system: RESOLVE_PROMPT,
      prompt: [
        `## Conflict (${input.conflict.kind})\n${input.conflict.summary}\n\n${input.conflict.context_md}`,
        input.conflict.evidence?.length
          ? `## Evidence\n${input.conflict.evidence.map((e) => `- (${e.source}) "${e.excerpt}"`).join("\n")}`
          : "",
        input.candidate
          ? `## Candidate (${input.candidate.kind}, id ${input.candidate.id})\n# ${input.candidate.title}\n${input.candidate.content_md.slice(0, 3000)}`
          : "## Candidate\n(none)",
        input.nodes.length
          ? `## Existing nodes\n${input.nodes.map(renderPlanNode).join("\n\n")}`
          : "## Existing nodes\n(none)",
        `## Human decision\n${input.decision}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      schema: PlanSchema,
    });
    void recordAiUsageEvent({
      workspaceId: input.workspaceId,
      surface: "ingest_extract",
      model,
      tokens: tokensFromUsage(result.usage),
      metadata: { phase: "resolve_conflict", conflict_id: input.conflict.id },
    });
    return result.object;
  } catch (err) {
    log.warn("nexo.resolve.model_error", {
      workspace_id: input.workspaceId,
      conflict_id: input.conflict.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      summary: "Decision recorded; NEXO could not plan node operations (model error).",
      actions: [{ op: "no_change", note: err instanceof Error ? err.message.slice(0, 200) : "model error" }],
    };
  }
}

/**
 * Apply a plan through the caller's storage (already narrowed to their
 * grant). Each action is independent and failures are recorded in the
 * resolution rather than thrown — a half-applied plan is visible, not lost.
 */
export async function applyPlan(
  storage: Storage,
  conflict: NexoConflict,
  candidate: IngestCandidate | null,
  plan: Plan,
  userId: string | null,
): Promise<NexoResolution> {
  const actions: NexoResolutionAction[] = [];
  const provenance = { nexo_conflict_id: conflict.id };
  const sb = getSupabaseAdmin();

  for (const action of plan.actions) {
    try {
      switch (action.op) {
        case "accept_candidate":
        case "accept_candidate_edited":
        case "supersede_node": {
          if (!candidate && action.op === "supersede_node") {
            actions.push(await supersedeBetweenNodes(storage, conflict, action));
            break;
          }
          if (!candidate) {
            actions.push({ op: action.op, note: "no candidate attached" });
            break;
          }
          if (action.op !== "accept_candidate" && (action.content_md || action.title)) {
            await sb
              .from("ingest_candidates")
              .update({
                ...(action.content_md ? { content_md: action.content_md } : {}),
                ...(action.title ? { title: action.title } : {}),
              })
              .eq("workspace_id", storage.workspace.id)
              .eq("id", candidate.id);
          }
          const accepted = await acceptCandidate(storage, candidate.id, userId);
          if (accepted.created_node_id) {
            // Stamp the conflict on the node so "why does this exist" is answerable.
            const created = await storage.getNode(accepted.created_node_id).catch(() => null);
            if (created) {
              await storage
                .updateNode(created.id, { data: { ...(created.data ?? {}), ...provenance } })
                .catch(() => null);
            }
            if (action.op === "supersede_node" && action.node_id) {
              await storage.createEdge({
                from_node: accepted.created_node_id,
                to_node: action.node_id,
                relation: "supersedes",
              });
            }
          }
          actions.push({
            op: action.op,
            node_id: accepted.created_node_id ?? undefined,
            title: accepted.title,
            note: action.note,
          });
          break;
        }
        case "dismiss_candidate": {
          if (candidate) await dismissCandidate(storage.workspace.id, candidate.id, userId);
          actions.push({ op: action.op, note: action.note });
          break;
        }
        case "update_block":
        case "append_block": {
          actions.push(await editBlock(storage, action));
          break;
        }
        case "create_decision": {
          if (!action.title || !action.content_md) {
            actions.push({ op: action.op, note: "missing title/content_md" });
            break;
          }
          const node = await storage.createNode({
            parent_id: null,
            kind: "decision",
            title: action.title,
            content_md: action.content_md,
            data: { ...provenance, ingest_source: "nexo_conflict" },
          });
          actions.push({ op: action.op, node_id: node.id, title: node.title, note: action.note });
          break;
        }
        case "no_change":
        default:
          actions.push({ op: "no_change", note: action.note });
      }
    } catch (err) {
      actions.push({
        op: action.op,
        node_id: action.node_id,
        note: `failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
      });
    }
  }

  return { summary: plan.summary, actions };
}

type PlanAction = Plan["actions"][number];

/**
 * A graph contradiction has no candidate: "A supersedes B" means one related
 * node replaces another. The edge is what degrades B in retrieval; the
 * appended block is what a reader of B sees. Neither touches B's own text.
 */
async function supersedeBetweenNodes(
  storage: Storage,
  conflict: NexoConflict,
  action: PlanAction,
): Promise<NexoResolutionAction> {
  const oldId = action.node_id;
  const newId = action.superseded_by;
  if (!oldId || !newId || oldId === newId) {
    return { op: action.op, node_id: oldId, note: "supersede_node without a candidate needs node_id (old) and superseded_by (new)" };
  }
  const related = new Set(conflict.related_node_ids ?? []);
  if (!related.has(oldId) || !related.has(newId)) {
    return { op: action.op, node_id: oldId, note: "both nodes must be related to the conflict" };
  }
  const [oldNode, newNode] = await Promise.all([storage.getNode(oldId), storage.getNode(newId)]);
  if (!oldNode || !newNode) {
    return { op: action.op, node_id: oldId, note: "node not found" };
  }
  await storage.createEdge({ from_node: newId, to_node: oldId, relation: "supersedes" });
  const day = new Date().toISOString().slice(0, 10);
  const edit = appendBlock(oldNode.content_md, {
    heading: `Superseded (${day})`,
    body_md: `${action.note?.trim() || "Superseded by a later decision."} See [${newNode.title}](/n/${newNode.id}).`,
  });
  // A second resolution on the same pair would find the heading taken; the
  // edge is idempotent and is the part that matters.
  if (edit.ok) await storage.updateNode(oldId, { content_md: edit.content_md });
  return { op: action.op, node_id: oldId, title: oldNode.title, note: `superseded by ${newNode.title}` };
}

/**
 * The only way the resolver writes into an existing node: one H2 block,
 * spliced by `replaceBlock`/`appendBlock` so the rest of the body is
 * untouched. Blocks the prompt stubbed as too long are refused — the model
 * never saw their full text and could only shorten them.
 */
async function editBlock(storage: Storage, action: PlanAction): Promise<NexoResolutionAction> {
  if (!action.node_id || !action.content_md) {
    return { op: action.op, node_id: action.node_id, note: "missing node_id/content_md" };
  }
  const node = await storage.getNode(action.node_id);
  if (!node) return { op: action.op, node_id: action.node_id, note: "node not found" };

  let edit;
  if (action.op === "append_block") {
    if (!action.heading) return { op: action.op, node_id: node.id, title: node.title, note: "append_block needs a heading" };
    edit = appendBlock(node.content_md, { heading: action.heading, body_md: action.content_md });
  } else {
    if (!action.block_id) return { op: action.op, node_id: node.id, title: node.title, note: "update_block needs a block_id" };
    const current = listBlocks(node.content_md).find((b) => b.block_id === action.block_id);
    if (current && current.body_md.length > BLOCK_PROMPT_LIMIT) {
      return { op: action.op, node_id: node.id, title: node.title, note: `block #${action.block_id} is too long to rewrite; append a note instead` };
    }
    edit = replaceBlock(node.content_md, node.data, {
      block_id: action.block_id,
      body_md: action.content_md,
      ...(action.heading ? { heading: action.heading } : {}),
    });
  }
  if (!edit.ok) return { op: action.op, node_id: node.id, title: node.title, note: edit.error.slice(0, 300) };
  await storage.updateNode(node.id, { content_md: edit.content_md });
  return { op: action.op, node_id: node.id, title: node.title, note: action.note };
}
