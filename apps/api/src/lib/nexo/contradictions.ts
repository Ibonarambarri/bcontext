/**
 * NEXO contradiction detection — does a recent change disagree with what
 * the graph already says?
 *
 * Two triggers, one scan:
 *
 *   - daily (`nexo.contradictions`, 05:00 UTC): every doc / decision / ADR
 *     edited in the last ~25 h;
 *   - on change: a write to one of those kinds enqueues the same job for
 *     that single node, singleton per node with a short delay, so a burst
 *     of edits costs one scan of the final text.
 *
 * For each H2 block of a changed node the retriever returns the semantically
 * closest blocks of OTHER nodes; each (block, block) pair the rules let
 * through is put to the model, and a contradiction opens a `nexo_conflicts`
 * row on the Conflicts surface with exact citations `/n/<id>#<block>` to
 * both sides. Nothing here edits a node: a model's inference is a doubt for
 * a human, never a truth. Dismissing the conflict is the normal resolution
 * and stays auditable.
 *
 * Skip rules (precision and cost):
 *   - a pair whose nodes are joined by a `supersedes` edge (either way) is
 *     already resolved;
 *   - a pair already judged for the current version of the node (an open
 *     conflict, or one raised after the node's last edit) is not re-asked;
 *   - `NEXO_CONTRADICTIONS_MAX_PAIRS` (50) model calls per workspace per
 *     day, counted through `ai_usage_events`.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { aiConfigured, languageModel } from "@/lib/ai/provider";
import { extractModel, extractProviderOptions } from "@/lib/ai/models";
import { log } from "@bcontext-dev/contract/log";
import { extractBlocks } from "@bcontext-dev/contract/rag/chunk";
import type { NexoConflictEvidence } from "@bcontext-dev/contract/nexo/conflicts";
import type { NodeEdge, NodeKind } from "@bcontext-dev/contract/types";
import { recordAiUsageEvent, tokensFromUsage } from "@/lib/telemetry/ai-usage";
import { enqueue } from "@/lib/queue/producers";
import { QUEUE_NEXO_CONTRADICTIONS } from "@/lib/queue/queues";
import type { OpenConflictInput } from "./conflicts";

const DEFAULT_MAX_PAIRS_PER_DAY = 50;
/** Kinds whose edits are worth comparing against the graph. */
export const CONTRADICTION_KINDS: readonly NodeKind[] = ["doc", "decision", "adr"] as const;
/** Seconds between a write and its scan; later writes in that window fold into it. */
const ON_CHANGE_DELAY_SECONDS = 120;
/** A block shorter than this carries no claim to contradict. */
const MIN_BLOCK_CHARS = 60;
/** Neighbours per block, and the similarity floor for a pair to be worth a model call. */
const NEIGHBOURS_PER_BLOCK = 4;
const MIN_SIMILARITY = 0.5;
/** Daily window: a little over a day so a late tick still covers yesterday's edits. */
const DAILY_WINDOW_HOURS = 25;
const DAILY_BATCH = 500;
const CHARS_PER_SIDE = 2500;

/** `NEXO_CONTRADICTIONS_MAX_PAIRS`: model calls per workspace per day; 0 disables judging. */
export function maxPairsPerDay(e: NodeJS.ProcessEnv = process.env): number {
  const n = Number(e.NEXO_CONTRADICTIONS_MAX_PAIRS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_PAIRS_PER_DAY;
}

export interface BlockRef {
  node_id: string;
  block_id: string;
  title: string;
  kind: string;
  text: string;
}

export interface CandidatePair {
  /** The changed block. */
  a: BlockRef;
  /** The neighbour from another node. */
  b: BlockRef;
  similarity: number;
}

export interface Verdict {
  contradiction: boolean;
  summary: string;
  contextMd: string;
  excerptA: string;
  excerptB: string;
}

export interface ScanNode {
  id: string;
  workspace_id: string;
  kind: string;
  title: string;
  content_md: string;
  updated_at: string;
}

export interface Neighbour {
  node_id: string;
  block_id: string | null;
  title: string;
  kind: string;
  content: string;
  similarity: number;
  superseded_by?: string | null;
}

/** A contradiction conflict already on file for a node, reduced to what the skip rule needs. */
export interface PriorConflict {
  status: string;
  created_at: string;
  urls: string[];
}

/**
 * Everything the scan touches outside its own logic, so the pair selection
 * and skip rules are unit-testable with a fake model and no database.
 */
export interface ContradictionDeps {
  neighbours(workspaceId: string, block: BlockRef, k: number): Promise<Neighbour[]>;
  judge(workspaceId: string, pair: CandidatePair): Promise<Verdict | null>;
  listEdges(workspaceId: string): Promise<NodeEdge[]>;
  priorConflicts(workspaceId: string, nodeId: string): Promise<PriorConflict[]>;
  openConflict(input: OpenConflictInput): Promise<{ id: string }>;
  /** Model calls already spent today in this workspace. */
  usedToday(workspaceId: string, now: Date): Promise<number>;
}

function blockRefUrl(ref: Pick<BlockRef, "node_id" | "block_id">): string {
  return `/n/${ref.node_id}#${ref.block_id}`;
}

/** Order-independent identity of a pair of blocks. */
export function pairKey(a: Pick<BlockRef, "node_id" | "block_id">, b: Pick<BlockRef, "node_id" | "block_id">): string {
  return [blockRefUrl(a), blockRefUrl(b)].sort().join("|");
}

/** H2 blocks of a node worth comparing: heading line dropped, short ones skipped. */
export function scanBlocks(node: Pick<ScanNode, "id" | "title" | "kind" | "content_md">): BlockRef[] {
  const out: BlockRef[] = [];
  for (const block of extractBlocks(node.content_md ?? "")) {
    const text = block.body_md.replace(/^#{1,6}\s+[^\n]*\n?/, "").trim();
    if (text.length < MIN_BLOCK_CHARS) continue;
    out.push({ node_id: node.id, block_id: block.block_id, title: node.title, kind: node.kind, text });
  }
  return out;
}

/** `supersedes` edges as an order-independent set of node pairs. */
function supersededPairs(edges: readonly NodeEdge[]): Set<string> {
  const out = new Set<string>();
  for (const e of edges) {
    if (e.relation !== "supersedes") continue;
    out.add([e.from_node, e.to_node].sort().join("|"));
  }
  return out;
}

/**
 * Pairs already answered for this version of the node. An open conflict is
 * still on the human's desk whatever the text says now; a resolved or
 * dismissed one counts only if it was raised after the node's last edit —
 * a dismissed false positive on text that has since changed is worth a
 * second look.
 */
export function judgedPairKeys(prior: readonly PriorConflict[], nodeUpdatedAt: string): Set<string> {
  const out = new Set<string>();
  for (const c of prior) {
    const refs = c.urls.filter((u) => /^\/n\/[^#]+#.+$/.test(u));
    if (refs.length < 2) continue;
    if (c.status !== "open" && c.created_at < nodeUpdatedAt) continue;
    out.add([refs[0]!, refs[1]!].sort().join("|"));
  }
  return out;
}

export interface SelectPairsInput {
  node: ScanNode;
  blocks: BlockRef[];
  neighboursOf: Map<string, Neighbour[]>;
  edges: readonly NodeEdge[];
  prior: readonly PriorConflict[];
  minSimilarity?: number;
}

/**
 * Which (changed block, neighbour block) pairs deserve a model call, best
 * first. Pure: given the retrieval results and the graph, no I/O.
 */
export function selectPairs(input: SelectPairsInput): CandidatePair[] {
  const min = input.minSimilarity ?? MIN_SIMILARITY;
  const superseded = supersededPairs(input.edges);
  const judged = judgedPairKeys(input.prior, input.node.updated_at);
  const seen = new Set<string>();
  const pairs: CandidatePair[] = [];
  for (const block of input.blocks) {
    for (const hit of input.neighboursOf.get(block.block_id) ?? []) {
      if (hit.node_id === input.node.id) continue;
      if (!CONTRADICTION_KINDS.includes(hit.kind as NodeKind)) continue;
      if (hit.similarity < min) continue;
      if (hit.superseded_by) continue;
      if (superseded.has([input.node.id, hit.node_id].sort().join("|"))) continue;
      const b: BlockRef = {
        node_id: hit.node_id,
        block_id: hit.block_id ?? "_unblocked",
        title: hit.title,
        kind: hit.kind,
        text: hit.content,
      };
      const key = pairKey(block, b);
      if (seen.has(key) || judged.has(key)) continue;
      seen.add(key);
      pairs.push({ a: block, b, similarity: hit.similarity });
    }
  }
  pairs.sort((x, y) => y.similarity - x.similarity);
  return pairs;
}

export interface ContradictionScanResult {
  nodes: number;
  blocks: number;
  candidates: number;
  judged: number;
  opened: number;
  /** Pairs left unjudged because the workspace hit its daily cap. */
  capped: number;
  workspaces: number;
}

export interface ScanOptions {
  /** Scan one node (on-change path). Without it: the daily sweep. */
  nodeId?: string | null;
  workspaceId?: string | null;
  now?: Date;
  maxPairs?: number;
  deps?: ContradictionDeps;
  /** Node loader; defaults to the service-role client. */
  loadNodes?: (opts: { nodeId?: string | null; since: string }) => Promise<ScanNode[]>;
}

/**
 * One scan, daily or per node (`opts.nodeId`). Returns counters only; the
 * conflicts it opens are the output. Injection points exist for tests.
 */
export async function runContradictionScan(opts: ScanOptions = {}): Promise<ContradictionScanResult> {
  const now = opts.now ?? new Date();
  const maxPairs = opts.maxPairs ?? maxPairsPerDay();
  const deps = opts.deps ?? defaultDeps();
  const since = new Date(now.getTime() - DAILY_WINDOW_HOURS * 3_600_000).toISOString();
  const nodes = await (opts.loadNodes ?? loadNodesFromSupabase)({ nodeId: opts.nodeId, since });
  const result: ContradictionScanResult = {
    nodes: 0, blocks: 0, candidates: 0, judged: 0, opened: 0, capped: 0, workspaces: 0,
  };

  const byWorkspace = new Map<string, ScanNode[]>();
  for (const n of nodes) {
    if (!CONTRADICTION_KINDS.includes(n.kind as NodeKind)) continue;
    if (opts.workspaceId && n.workspace_id !== opts.workspaceId) continue;
    byWorkspace.set(n.workspace_id, [...(byWorkspace.get(n.workspace_id) ?? []), n]);
  }

  for (const [workspaceId, wsNodes] of byWorkspace) {
    result.workspaces += 1;
    let budget = Math.max(0, maxPairs - (await deps.usedToday(workspaceId, now)));
    const edges = await deps.listEdges(workspaceId);
    // Pairs judged in this run: the same two blocks can surface from either side.
    const judgedNow = new Set<string>();

    for (const node of wsNodes) {
      result.nodes += 1;
      const blocks = scanBlocks(node);
      result.blocks += blocks.length;
      if (blocks.length === 0) continue;

      const neighboursOf = new Map<string, Neighbour[]>();
      for (const block of blocks) {
        try {
          neighboursOf.set(block.block_id, await deps.neighbours(workspaceId, block, NEIGHBOURS_PER_BLOCK));
        } catch (err) {
          log.warn("nexo.contradictions.retrieval_failed", {
            workspace_id: workspaceId,
            node_id: node.id,
            block_id: block.block_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const prior = await deps.priorConflicts(workspaceId, node.id);
      const pairs = selectPairs({ node, blocks, neighboursOf, edges, prior }).filter(
        (p) => !judgedNow.has(pairKey(p.a, p.b)),
      );
      result.candidates += pairs.length;

      for (const pair of pairs) {
        if (budget <= 0) {
          result.capped += 1;
          continue;
        }
        budget -= 1;
        judgedNow.add(pairKey(pair.a, pair.b));
        result.judged += 1;
        const verdict = await deps.judge(workspaceId, pair);
        if (!verdict?.contradiction) continue;
        const evidence: NexoConflictEvidence[] = [
          { source: "graph", url: blockRefUrl(pair.a), excerpt: verdict.excerptA.slice(0, 400) },
          { source: "graph", url: blockRefUrl(pair.b), excerpt: verdict.excerptB.slice(0, 400) },
        ];
        const conflict = await deps.openConflict({
          workspaceId,
          kind: "contradiction",
          summary: verdict.summary,
          contextMd: verdict.contextMd,
          evidence,
          relatedNodeIds: [pair.a.node_id, pair.b.node_id],
        });
        result.opened += 1;
        log.info("nexo.contradictions.opened", {
          workspace_id: workspaceId,
          conflict_id: conflict.id,
          a: blockRefUrl(pair.a),
          b: blockRefUrl(pair.b),
        });
      }
    }
  }
  return result;
}

// -- On-change trigger --------------------------------------------------------

/**
 * Queue a scan of one node, folded per node: while a scan for this node is
 * pending, further writes do not add jobs, and the one that runs reads the
 * text as it is then. Returns null when the queue runtime is off (no
 * DATABASE_URL); the daily sweep still covers the node.
 */
export async function enqueueContradictionScan(args: {
  workspaceId: string;
  nodeId: string;
  delaySeconds?: number;
}): Promise<string | null> {
  return enqueue(
    QUEUE_NEXO_CONTRADICTIONS,
    { workspace_id: args.workspaceId, node_id: args.nodeId },
    { singletonKey: `node:${args.nodeId}`, startAfter: args.delaySeconds ?? ON_CHANGE_DELAY_SECONDS },
  );
}

// -- Default wiring -----------------------------------------------------------

async function loadNodesFromSupabase(opts: { nodeId?: string | null; since: string }): Promise<ScanNode[]> {
  const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
  let query = getSupabaseAdmin()
    .from("nodes")
    .select("id, workspace_id, kind, title, content_md, updated_at")
    .in("kind", [...CONTRADICTION_KINDS]);
  query = opts.nodeId
    ? query.eq("id", opts.nodeId)
    : query.gte("updated_at", opts.since).order("updated_at", { ascending: false }).limit(DAILY_BATCH);
  const { data, error } = await query;
  if (error) throw new Error(`contradictions: listing nodes failed: ${error.message}`);
  return (data ?? []) as ScanNode[];
}

const VerdictSchema = z.object({
  contradiction: z.boolean(),
  summary: z.string().min(1).max(300),
  context_md: z.string().min(1),
  excerpt_a: z.string().min(1).max(400),
  excerpt_b: z.string().min(1).max(400),
});

const JUDGE_PROMPT = `You compare two sections of a company's knowledge graph that talk about the same topic. Section A was just edited; section B is existing knowledge from another node.
A CONTRADICTION is when the two state incompatible things (different numbers, opposite decisions, mutually exclusive plans) AND neither says the other changed (no "we changed", "previously", "supersedes", "instead of", dates that explain the difference).
Not a contradiction: adding detail, different topics, the same fact in other words, an explicit update that acknowledges the previous state, or vagueness.
Answer in the language of section A — never switch to English when section A is in Spanish. summary: one sentence a busy person reads in a list ("<A title> says X, but <B title> says Y."). context_md: both claims with the exact sentences and why it matters, under "## A" and "## B" headings. excerpt_a / excerpt_b: verbatim quotes from each section.
Before deciding, check the three exits in order: (1) do both sections really talk about the same fact? (2) does either section say the other changed — dates, "antes", "previously", "pasa de", "ahora", "supersedes"? If yes, it is an update, not a contradiction. (3) only then compare the values.`;
// The "three exits" line is the difference between 0.81 and 0.94-1.00 on the
// labelled pairs in scripts/ai-bench (2026-09-10): every model, Sonnet
// included, was reading an acknowledged price change as a contradiction.

function defaultDeps(): ContradictionDeps {
  return {
    async neighbours(workspaceId, block, k) {
      const { retrieveScoped } = await import("@/lib/rag");
      const result = await retrieveScoped(workspaceId, block.text.slice(0, 800), {
        k: k + 2,
        kinds: [...CONTRADICTION_KINDS],
      });
      return result.hits
        .filter((h) => h.node_id !== block.node_id)
        .slice(0, k)
        .map((h) => ({
          node_id: h.node_id,
          block_id: h.block_id,
          title: h.title,
          kind: h.kind,
          content: h.content,
          similarity: h.similarity,
          superseded_by: h.superseded_by ?? null,
        }));
    },
    async judge(workspaceId, pair) {
      if (!aiConfigured()) return null;
      const model = extractModel();
      try {
        const result = await generateObject({
          model: languageModel(model),
          providerOptions: extractProviderOptions(model),
          system: JUDGE_PROMPT,
          prompt: [
            `## Section A (${pair.a.kind}) — ${blockRefUrl(pair.a)}\n# ${pair.a.title}\n${pair.a.text.slice(0, CHARS_PER_SIDE)}`,
            `## Section B (${pair.b.kind}) — ${blockRefUrl(pair.b)}\n# ${pair.b.title}\n${pair.b.text.slice(0, CHARS_PER_SIDE)}`,
          ].join("\n\n"),
          schema: VerdictSchema,
        });
        void recordAiUsageEvent({
          workspaceId,
          surface: "ingest_extract",
          model,
          tokens: tokensFromUsage(result.usage),
          providerMetadata: result.providerMetadata,
          metadata: { phase: "contradiction_scan", a: blockRefUrl(pair.a), b: blockRefUrl(pair.b) },
        });
        return {
          contradiction: result.object.contradiction,
          summary: result.object.summary,
          contextMd: result.object.context_md,
          excerptA: result.object.excerpt_a,
          excerptB: result.object.excerpt_b,
        };
      } catch (err) {
        log.warn("nexo.contradictions.model_error", {
          workspace_id: workspaceId,
          model,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },
    async listEdges(workspaceId) {
      const { getStorageById } = await import("@/lib/storage");
      const storage = await getStorageById(workspaceId);
      return storage ? storage.listEdges() : [];
    },
    async priorConflicts(workspaceId, nodeId) {
      const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
      const { data, error } = await getSupabaseAdmin()
        .from("nexo_conflicts")
        .select("status, created_at, evidence")
        .eq("workspace_id", workspaceId)
        .eq("kind", "contradiction")
        .contains("related_node_ids", [nodeId])
        .limit(500);
      if (error) throw new Error(`contradictions: reading prior conflicts failed: ${error.message}`);
      const rows = (data ?? []) as Array<{ status: string; created_at: string; evidence: unknown }>;
      return rows.map((row) => ({
        status: row.status,
        created_at: row.created_at,
        urls: (Array.isArray(row.evidence) ? (row.evidence as Array<{ url?: string }>) : [])
          .map((e) => e.url)
          .filter((u): u is string => typeof u === "string"),
      }));
    },
    async openConflict(input) {
      const { openConflict } = await import("./conflicts");
      return openConflict(input);
    },
    async usedToday(workspaceId, now) {
      const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
      const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
      const { count, error } = await getSupabaseAdmin()
        .from("ai_usage_events")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("surface", "ingest_extract")
        .eq("metadata->>phase", "contradiction_scan")
        .gte("created_at", dayStart);
      if (error) {
        log.warn("nexo.contradictions.usage_read_failed", { workspace_id: workspaceId, error: error.message });
        return 0;
      }
      return count ?? 0;
    },
  };
}
