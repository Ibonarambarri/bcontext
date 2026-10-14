/**
 * `brief`: the first call of an agent's session, and the only one it should
 * need before it can act.
 *
 * The agent lab (2026-09-03) measured four to six calls between "connected"
 * and the first useful write: list tasks, list decisions, list views, read
 * the change feed, then work out what all of it means. This is that sequence
 * as one read, in a fixed compact shape, with one thing no sequence of tools
 * could give: a "since" the server remembers per token (`api_tokens.
 * last_brief_at`, migration 0081), so "what changed" needs no bookkeeping on
 * the agent's side and survives a new session.
 *
 * The lists are the same predicates the rest of the surface uses — the
 * unblocked rule is `@/lib/views/unblocked`, the changes are `list_changes`,
 * the views are `views(op=list)` — so nothing here can disagree with the tool
 * an agent would call next.
 */
import {
  isTerminalStatus,
  type GoalStatus,
  type KnowledgeNode,
  type NodeSummary,
} from "@bcontext-dev/contract/types";
import { goalData, goalProgress, type GoalScope } from "@bcontext-dev/contract/goals";
import type { ViewPrincipal } from "@bcontext-dev/contract/views/types";
import { log } from "@bcontext-dev/contract/log";
import type { Storage } from "@/lib/storage";
import { listChangePageForStorage } from "@/lib/activity";
import { listViews } from "@/lib/views/store";
import { indexBlockers, isUnblocked } from "@/lib/views/unblocked";
import {
  goalHealth,
  indexGoalPressure,
  reviewStatus,
  type GoalPressure,
} from "@/lib/goals";

/** Same ceiling `nodes(op=list)` scans; a workspace above it reports `truncated`. */
const SCAN_CEILING = 5000;
/** Change entries per brief: enough to see a day, small enough to stay a brief. */
const CHANGES_LIMIT = 20;
/**
 * Strategic changes are read in their own pass rather than filtered out of the
 * page above: they are rare and they matter, so they must not be pushed out of
 * the window by twenty ordinary edits made the same afternoon.
 */
const STRATEGIC_CHANGES_LIMIT = 10;

export interface BriefContext {
  storage: Storage;
  workspaceRef: string;
  /** Ids a node's `assignee_id` may carry for this caller: agent, user, token creator. */
  principalIds: string[];
  viewPrincipal: ViewPrincipal;
  /** How many external tools this caller may call through capability_call (the catalog, re-read). */
  countExternalTools: () => Promise<number>;
}

export interface BriefOptions {
  /** Entries per list (unblocked, open decisions, for_you). */
  top: number;
  /** ISO timestamp the change feed starts from; null for "no previous brief". */
  since: string | null;
}

export interface BriefNode {
  id: string;
  title: string;
  kind: string;
  status: string | null;
  priority: string | null;
  updated_at: string;
  /**
   * The objective this piece of work pushes, when it pushes one. Present so
   * the order is explainable: a queue that has been re-sorted by something the
   * reader cannot see is a queue the reader has to distrust.
   */
  goal?: { id: string; title: string; status: GoalStatus | null; urgency: number };
}

export interface BriefGoal {
  id: string;
  title: string;
  scope: GoalScope | null;
  /** The North Star: the one goal the others answer to, and it never expires. */
  root: boolean;
  status: GoalStatus | null;
  /**
   * 0..1 across the measurable key results — `null` when NONE of them are.
   * Never 0: "nobody has moved the needle" and "there is no needle" are
   * different facts, and reporting the second as the first is how a goal with
   * no key results ends up looking like a goal that is failing.
   */
  progress: number | null;
  /** Only when `progress` is null, saying which of the two cases this is. */
  progress_note?: string;
  /** Progress against time spent: ahead | on_pace | behind, null if unbounded. */
  pace: string | null;
  due_date: string | null;
  cycle: string | null;
  key_results: number;
  /** Set when the goal is past the review cadence it declared. */
  review_overdue?: { every: string; last_reviewed_at: string | null; days: number };
}

export interface Brief {
  generated_at: string;
  /** Where `changes` starts: the previous brief, or the caller's `since`. */
  since: string | null;
  counts: {
    nodes: number;
    by_kind: Record<string, number>;
    by_status: Record<string, number>;
    truncated: boolean;
  };
  /** Actionable nodes with no live blocker, best priority first. */
  unblocked: { total: number; top: BriefNode[] };
  /** Decisions carrying a non-terminal workflow status — still being decided. */
  open_decisions: { total: number; top: BriefNode[] };
  /** Non-terminal nodes assigned to this principal: the questions waiting on you. */
  for_you: { total: number; top: BriefNode[] };
  /**
   * What the workspace is aiming at, and whether it is getting there. Active
   * means today falls inside `data.timeframe.start` → `due_date`; the North
   * Star has neither and so is always active — a mission does not expire.
   */
  goals: {
    /** How many goals are active, the North Star included. */
    total: number;
    north_star: BriefGoal | null;
    /** The active goals except the North Star, the ones in trouble first. */
    top: BriefGoal[];
    /** Past the cadence they promised. What stops objectives from rotting. */
    needs_review: BriefGoal[];
    /**
     * Writes to the North Star or a company goal since `since`. Permitted is
     * not the same as unremarkable: `goals:write` decides who may, this
     * decides who hears about it.
     */
    strategic_changes: {
      total: number;
      top: Array<{ ts: string; action: string; node_id: string | null; title: string | null; summary: string | null; actor: string }>;
    };
  };
  changes: {
    since: string | null;
    entries: Array<{
      ts: string;
      action: string;
      node_id: string | null;
      title: string | null;
      block_id: string | null;
      summary: string | null;
      actor: string;
    }>;
    /** More entries exist past `entries`; list_changes({ since }) pages them. */
    more: boolean;
  };
  views: Array<{ id: string; name: string; renderer: string; system_key: string | null }>;
  /**
   * What `capability_search` would find: the external tools this caller has
   * been granted and the workspace's skills. Neither is in tools/list, so an
   * agent that is never told they exist never looks for them.
   */
  capabilities: { external_tools: number; skills: number };
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, med: 2, low: 3 };

function rank(priority: string | null): number {
  return priority === null ? 4 : (PRIORITY_RANK[priority] ?? 4);
}

/** Best priority first, then most recently touched. */
function byPriority(a: NodeSummary, b: NodeSummary): number {
  return rank(a.priority) - rank(b.priority) || b.updated_at.localeCompare(a.updated_at);
}

/**
 * The same order, with the objective as the tiebreak.
 *
 * Strictly lexicographic, and the priority band comes first: a `low` task that
 * pushes a company goal in trouble can never overtake an `urgent` one that
 * pushes nothing. What the goal decides is the order INSIDE a band — which is
 * where a topological queue has nothing to say and picks by timestamp, i.e. by
 * accident.
 *
 * The other half of the rule is what happens to work that belongs to no
 * objective, which is most work: it keeps its band and only ever loses to
 * peers of the SAME priority that are pushing something at risk. It does not
 * sink, because a healthy goal exerts no pressure at all — the tiebreak is
 * distress, not membership.
 */
function byPriorityThenGoal(
  pressure: ReadonlyMap<string, GoalPressure>,
): (a: NodeSummary, b: NodeSummary) => number {
  const urgency = (node: NodeSummary) => pressure.get(node.id)?.urgency ?? 0;
  return (a, b) =>
    rank(a.priority) - rank(b.priority) ||
    urgency(b) - urgency(a) ||
    b.updated_at.localeCompare(a.updated_at);
}

function byRecency(a: NodeSummary, b: NodeSummary): number {
  return b.updated_at.localeCompare(a.updated_at);
}

function card(node: NodeSummary, pressure?: ReadonlyMap<string, GoalPressure>): BriefNode {
  const goal = pressure?.get(node.id);
  return {
    id: node.id,
    title: node.title,
    kind: node.kind,
    status: node.status,
    priority: node.priority,
    updated_at: node.updated_at,
    ...(goal
      ? { goal: { id: goal.goal_id, title: goal.title, status: goal.status, urgency: goal.urgency } }
      : {}),
  };
}

function goalCard(node: KnowledgeNode, today: string): BriefGoal {
  const data = goalData(node);
  const health = goalHealth(node, today);
  const keyResults = data.key_results ?? [];
  const progress = goalProgress(keyResults);
  const review = reviewStatus(node, today);
  return {
    id: node.id,
    title: node.title,
    scope: data.scope ?? null,
    root: data.root === true,
    status: health.status,
    progress,
    ...(progress === null
      ? {
          progress_note:
            keyResults.length === 0
              ? "no key results yet — nothing to measure"
              : "no measurable key result (baseline equals target)",
        }
      : {}),
    pace: health.pace,
    due_date: node.due_date,
    cycle: data.timeframe?.cycle ?? null,
    key_results: keyResults.length,
    ...(review
      ? { review_overdue: { every: review.every, last_reviewed_at: review.last_reviewed_at, days: review.days_overdue } }
      : {}),
  };
}

function tally<T>(items: readonly T[], key: (item: T) => string | null): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export async function buildBrief(ctx: BriefContext, options: BriefOptions): Promise<Brief> {
  const generatedAt = new Date().toISOString();
  const top = Math.max(1, options.top);
  const today = generatedAt.slice(0, 10);
  const [nodes, edges, views, changes, goalNodes, goalChanges, externalTools] = await Promise.all([
    ctx.storage.listNodeSummaries({ limit: SCAN_CEILING }),
    ctx.storage.listEdges(),
    listViews(ctx.storage, ctx.viewPrincipal),
    listChangePageForStorage(ctx.storage, ctx.workspaceRef, {
      since: options.since ?? undefined,
      limit: CHANGES_LIMIT,
    }),
    // Full nodes, not summaries: scope, key results and the timeframe live in
    // `data`, which the summary index drops. Bounded to one kind so the cost
    // is the dozen goals a workspace has, not its whole markdown.
    ctx.storage.listNodes({ kinds: ["goal"], limit: SCAN_CEILING }),
    listChangePageForStorage(ctx.storage, ctx.workspaceRef, {
      since: options.since ?? undefined,
      nodeKinds: ["goal"],
      limit: STRATEGIC_CHANGES_LIMIT,
    }),
    // A catalog outage costs the brief its counter, never the brief; the
    // agent will find out on capability_search, which does not swallow it.
    ctx.countExternalTools().catch((error: unknown) => {
      log.warn("mcp.brief.capabilities.count_failed", {
        error: error instanceof Error ? error.message : "unknown error",
      });
      return 0;
    }),
  ]);

  const live = nodes.filter((node) => node.status !== "archived");
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const blockers = indexBlockers(edges);

  // The queue stops being a topological order and starts having intent here.
  const pressure = indexGoalPressure(goalNodes, edges, nodes, today);
  const unblocked = live
    .filter((node) => isUnblocked(node, blockers, byId))
    .sort(byPriorityThenGoal(pressure));
  const openDecisions = live
    .filter((node) => node.kind === "decision" && node.status !== null && !isTerminalStatus(node.status))
    .sort(byRecency);
  const mine = new Set(ctx.principalIds);
  const forYou = live
    .filter((node) => node.assignee_id !== null && mine.has(node.assignee_id) && !isTerminalStatus(node.status))
    .sort(byPriorityThenGoal(pressure));

  const goalCards = goalNodes
    .filter((goal) => goal.status !== "archived")
    .map((goal) => ({ goal, card: goalCard(goal, today), active: goalHealth(goal, today).active }));
  const activeGoals = goalCards
    .filter((entry) => entry.active)
    // The one in trouble first; then the one running out of time soonest. A
    // goal with no deadline sorts last rather than first: it is not urgent,
    // it is undated.
    .sort(
      (a, b) =>
        (pressure.get(b.goal.id)?.urgency ?? 0) - (pressure.get(a.goal.id)?.urgency ?? 0) ||
        (a.card.due_date ?? "9999").localeCompare(b.card.due_date ?? "9999"),
    );
  const needsReview = activeGoals.filter((entry) => entry.card.review_overdue);
  const strategicChanges = goalChanges.entries.filter((entry) => entry.strategic);

  return {
    generated_at: generatedAt,
    since: options.since,
    counts: {
      nodes: live.length,
      by_kind: tally(live, (node) => node.kind),
      by_status: tally(nodes, (node) => node.status),
      truncated: nodes.length >= SCAN_CEILING,
    },
    unblocked: { total: unblocked.length, top: unblocked.slice(0, top).map((node) => card(node, pressure)) },
    open_decisions: { total: openDecisions.length, top: openDecisions.slice(0, top).map((node) => card(node)) },
    for_you: { total: forYou.length, top: forYou.slice(0, top).map((node) => card(node, pressure)) },
    goals: {
      total: activeGoals.length,
      north_star: goalCards.find((entry) => entry.card.root)?.card ?? null,
      // The North Star is the frame, reported on its own line; repeating it in
      // the list would spend a slot saying what the line above already said.
      top: activeGoals.filter((entry) => !entry.card.root).slice(0, top).map((entry) => entry.card),
      needs_review: needsReview.slice(0, top).map((entry) => entry.card),
      strategic_changes: {
        total: strategicChanges.length,
        top: strategicChanges.slice(0, top).map((entry) => ({
          ts: entry.ts,
          action: entry.action,
          node_id: entry.node_id,
          title: entry.node_title,
          summary: entry.summary,
          actor: entry.actor.name,
        })),
      },
    },
    changes: {
      since: options.since,
      entries: changes.entries.map((entry) => ({
        ts: entry.ts,
        action: entry.kind,
        node_id: entry.node_id,
        title: entry.node_title,
        block_id: entry.block_id,
        summary: entry.summary,
        actor: entry.actor.name,
      })),
      more: changes.next_cursor !== null,
    },
    views: views.map((view) => ({
      id: view.id,
      name: view.name,
      renderer: view.presentation.renderer,
      system_key: view.system_key,
    })),
    capabilities: {
      external_tools: externalTools,
      skills: live.filter((node) => node.kind === "skill").length,
    },
  };
}

// ---- last_brief_at ---------------------------------------------------------
//
// Remembered per token. Supabase-backed workspaces keep it on the token row;
// demo workspaces keep it in process memory, which is enough for a session and
// for the tests. Neither path may fail a brief: a missing column (migration
// not yet applied) or a token that lives in another table (OAuth, user tokens)
// degrades to "no previous brief", never to an error.

const demoBriefs = new Map<string, string>();

export async function readLastBriefAt(storage: Storage, tokenId: string): Promise<string | null> {
  if (storage.backend !== "supabase") return demoBriefs.get(tokenId) ?? null;
  try {
    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    const { data, error } = await getSupabaseAdmin()
      .from("api_tokens")
      .select("last_brief_at")
      .eq("id", tokenId)
      .maybeSingle();
    if (error) {
      log.warn("mcp.brief.last_brief_at.read_failed", { tokenId, error: error.message });
      return null;
    }
    return (data?.last_brief_at as string | null | undefined) ?? null;
  } catch (err) {
    log.warn("mcp.brief.last_brief_at.read_failed", { tokenId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function stampBriefAt(storage: Storage, tokenId: string, at: string): Promise<void> {
  if (storage.backend !== "supabase") {
    demoBriefs.set(tokenId, at);
    return;
  }
  try {
    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    const { error } = await getSupabaseAdmin()
      .from("api_tokens")
      .update({ last_brief_at: at })
      .eq("id", tokenId);
    if (error) log.warn("mcp.brief.last_brief_at.write_failed", { tokenId, error: error.message });
  } catch (err) {
    log.warn("mcp.brief.last_brief_at.write_failed", { tokenId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Test seam: forget every demo token's last brief. */
export function resetDemoBriefsForTests(): void {
  demoBriefs.clear();
}
