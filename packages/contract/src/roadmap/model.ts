/**
 * The roadmap as a pure model: goals as rows, derived horizons as columns,
 * the tasks and bugs that contribute to each goal as the cells.
 *
 * Nothing here is stored. A row is a goal node (the tree under the North
 * Star, in tree order); a card lands in a row through its `contributes_to`
 * edge and in a column through its status, priority and active blockers —
 * the same facts the board and `unblocked` already read. An agent that wants
 * to "move" something changes the status, the priority, the edges; the
 * roadmap follows. There is no `horizon` field that could drift.
 *
 * The API computes it (`views(op=resolve)` and `POST /api/views/:id/resolve`
 * for a `roadmap` renderer) and the web renders it; both read this one
 * function, so what an agent is told and what a person sees are the same.
 * `RULES_VERSION` names the horizon rule so a saved view can pin one when the
 * rule changes.
 */
import { goalData, goalProgress, isGoalActive, resolveTimeframe } from "../goals.js";
import { nodeSubtaskProgress } from "../subtasks.js";
import type { GoalStatus, KnowledgeNode, NodeEdge, NodeKind, NodeStatus, Priority } from "../types.js";
import type { SubtaskProgress } from "../subtasks.js";
import type { ViewPresentation } from "../views/schema.js";

export const ROADMAP_RULES_VERSION = 1 as const;

export const ROADMAP_HORIZONS = ["now", "next", "later"] as const;
export type RoadmapHorizon = (typeof ROADMAP_HORIZONS)[number];

export const ROADMAP_HORIZON_LABELS: Record<RoadmapHorizon, string> = {
  now: "Now",
  next: "Next",
  later: "Later",
};

/** The row of a card that contributes to no goal. */
export const ROADMAP_UNASSIGNED_LANE = "unassigned" as const;

export const ROADMAP_DEFAULT_DONE_WINDOW_DAYS = 30;

/** What a saved view may pin under `presentation.layout.roadmap`. */
export interface RoadmapLayout {
  done_window_days?: number;
  rules_version?: number;
}

export interface RoadmapGoal {
  id: string;
  title: string;
  slug: string;
  parent_id: string | null;
  root: boolean;
  scope: "company" | "project" | null;
  status: GoalStatus | null;
  /** The window, as the goal contract resolves it: a quarter label when the dates are one. */
  cycle: string | null;
  start: string | null;
  end: string | null;
  /** 0..1 across measurable key results; null when nothing is measurable. */
  progress: number | null;
  active: boolean;
}

export interface RoadmapCard {
  id: string;
  title: string;
  kind: NodeKind;
  status: NodeStatus | null;
  priority: Priority | null;
  due_date: string | null;
  updated_at: string;
  subtasks: SubtaskProgress | null;
  /** Titles of the blockers still open, so the card can say what it waits on. */
  blocked_by: string[];
  horizon: RoadmapHorizon | "done";
}

export interface RoadmapLane {
  /** The goal id, or `unassigned`. */
  id: string;
  goal: RoadmapGoal | null;
  /** Tree depth under the North Star: 0 for company goals. */
  depth: number;
  cells: Record<RoadmapHorizon, RoadmapCard[]>;
  /** Done inside the window, kept apart so the live columns stay live. */
  done: RoadmapCard[];
  total: number;
}

export interface RoadmapModel {
  rules_version: typeof ROADMAP_RULES_VERSION;
  today: string;
  done_window_days: number;
  north_star: RoadmapGoal | null;
  columns: Array<{ id: RoadmapHorizon; label: string }>;
  lanes: RoadmapLane[];
}

export interface RoadmapInput {
  /** Every goal node of the workspace, full (`data` carries the timeframe and key results). */
  goals: KnowledgeNode[];
  /** The nodes the view resolved to — tasks and bugs. */
  items: KnowledgeNode[];
  /**
   * The workspace index, for blocker statuses and titles. May be the items
   * themselves when nothing else is known; blockers outside it count as open.
   */
  index: KnowledgeNode[];
  edges: NodeEdge[];
  today?: string;
  presentation?: ViewPresentation;
}

export function readRoadmapLayout(presentation: ViewPresentation | undefined): Required<RoadmapLayout> {
  const raw = (presentation?.layout as { roadmap?: RoadmapLayout } | undefined)?.roadmap ?? {};
  const days = typeof raw.done_window_days === "number" && raw.done_window_days > 0
    ? Math.floor(raw.done_window_days)
    : ROADMAP_DEFAULT_DONE_WINDOW_DAYS;
  return { done_window_days: days, rules_version: ROADMAP_RULES_VERSION };
}

/** A goal node as the roadmap describes it. */
export function roadmapGoal(node: KnowledgeNode, today: string): RoadmapGoal {
  const data = goalData(node);
  const window = resolveTimeframe({
    cycle: data.timeframe?.cycle ?? null,
    start: data.timeframe?.start ?? null,
    end: node.due_date ? node.due_date.slice(0, 10) : null,
  });
  return {
    id: node.id,
    title: node.title,
    slug: node.slug,
    parent_id: node.parent_id,
    root: data.root === true,
    scope: data.scope ?? null,
    status: (node.status as GoalStatus | null) ?? null,
    cycle: window.cycle,
    start: window.start,
    end: window.end,
    progress: goalProgress(data.key_results),
    active: isGoalActive(node, today),
  };
}

const TERMINAL: ReadonlySet<string> = new Set(["done", "archived"]);
const DAY_MS = 86_400_000;

/**
 * The horizon rule (version 1). Deliberately a function of what the node
 * already says:
 *   now   — in progress or in review; a todo nobody blocks, marked high or urgent
 *   next  — the other unblocked todos; blocked work whose open blockers are
 *           all in `now`; an urgent backlog item
 *   later — the backlog; blocked work waiting on something further out
 *   done  — done inside the window (older done and archived are not shown)
 * A todo with an open blocker is treated as blocked whatever its status says:
 * the edge is the fact, the status is a label someone may not have updated.
 */
export function roadmapHorizon(
  node: Pick<KnowledgeNode, "status" | "priority" | "updated_at">,
  openBlockers: ReadonlyArray<Pick<KnowledgeNode, "status" | "priority">>,
  options: { today: string; doneWindowDays: number },
): RoadmapHorizon | "done" | null {
  const status = node.status;
  if (status === "archived") return null;
  if (status === "done") {
    const age = (Date.parse(options.today) - Date.parse(node.updated_at.slice(0, 10))) / DAY_MS;
    return age <= options.doneWindowDays ? "done" : null;
  }
  const urgent = node.priority === "urgent";
  const pressing = urgent || node.priority === "high";
  if (openBlockers.length > 0 || status === "blocked") {
    if (openBlockers.length === 0) return "later";
    const blockersNow = openBlockers.every((blocker) => roadmapHorizon(
      { ...blocker, updated_at: options.today },
      [],
      options,
    ) === "now");
    return blockersNow ? "next" : "later";
  }
  if (status === "in_progress" || status === "review") return "now";
  if (status === "todo") return pressing ? "now" : "next";
  if (status === "backlog") return urgent ? "next" : "later";
  // A task with no status is a backlog item that never got one.
  return "later";
}

function openBlockersOf(id: string, edges: readonly NodeEdge[], byId: Map<string, KnowledgeNode>): KnowledgeNode[] {
  const out: KnowledgeNode[] = [];
  for (const edge of edges) {
    if (edge.relation !== "blocked_by" || edge.from_node !== id) continue;
    const blocker = byId.get(edge.to_node);
    // An unknown blocker is one the caller cannot see; it still blocks.
    if (!blocker) {
      out.push({ id: edge.to_node, title: edge.to_node, status: "todo", priority: null } as KnowledgeNode);
      continue;
    }
    if (!TERMINAL.has(blocker.status ?? "")) out.push(blocker);
  }
  return out;
}

/** Goals in tree order under the North Star, each with its depth; orphans last. */
function orderGoals(goals: RoadmapGoal[]): Array<{ goal: RoadmapGoal; depth: number }> {
  const byParent = new Map<string | null, RoadmapGoal[]>();
  for (const goal of goals) {
    const list = byParent.get(goal.parent_id) ?? [];
    list.push(goal);
    byParent.set(goal.parent_id, list);
  }
  const ids = new Set(goals.map((goal) => goal.id));
  const ordered: Array<{ goal: RoadmapGoal; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    for (const goal of byParent.get(parentId) ?? []) {
      if (seen.has(goal.id)) continue;
      seen.add(goal.id);
      ordered.push({ goal, depth });
      walk(goal.id, depth + 1);
    }
  };
  const root = goals.find((goal) => goal.root) ?? null;
  if (root) {
    seen.add(root.id);
    walk(root.id, 0);
  }
  // Company goals with no North Star to hang from, then project goals whose
  // parent is not a goal in the set: a row each, so nothing is hidden.
  for (const goal of goals) {
    if (seen.has(goal.id)) continue;
    if (goal.parent_id && ids.has(goal.parent_id)) continue;
    seen.add(goal.id);
    ordered.push({ goal, depth: 0 });
    walk(goal.id, 1);
  }
  return ordered;
}

export function buildRoadmap(input: RoadmapInput): RoadmapModel {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const layout = readRoadmapLayout(input.presentation);
  const options = { today, doneWindowDays: layout.done_window_days };

  const byId = new Map<string, KnowledgeNode>();
  for (const node of input.index) byId.set(node.id, node);
  for (const node of input.items) byId.set(node.id, node);
  for (const node of input.goals) byId.set(node.id, node);

  const goals = input.goals.filter((node) => node.kind === "goal").map((node) => roadmapGoal(node, today));
  const goalIds = new Set(goals.map((goal) => goal.id));
  const northStar = goals.find((goal) => goal.root) ?? null;

  // A card belongs to the first goal it contributes to; several edges never
  // duplicate it (same rule as the board's tag columns).
  const laneOf = new Map<string, string>();
  for (const edge of input.edges) {
    if (edge.relation !== "contributes_to" || !goalIds.has(edge.to_node) || laneOf.has(edge.from_node)) continue;
    laneOf.set(edge.from_node, edge.to_node);
  }

  const cardsByLane = new Map<string, RoadmapCard[]>();
  for (const node of input.items) {
    if (node.kind === "goal") continue;
    const blockers = openBlockersOf(node.id, input.edges, byId);
    const horizon = roadmapHorizon(node, blockers, options);
    if (!horizon) continue;
    const card: RoadmapCard = {
      id: node.id,
      title: node.title,
      kind: node.kind,
      status: node.status,
      priority: node.priority,
      due_date: node.due_date,
      updated_at: node.updated_at,
      subtasks: nodeSubtaskProgress({ data: node.data, subtasks: (node as { subtasks?: SubtaskProgress | null }).subtasks }),
      blocked_by: blockers.map((blocker) => blocker.title),
      horizon,
    };
    const laneId = laneOf.get(node.id) ?? ROADMAP_UNASSIGNED_LANE;
    const list = cardsByLane.get(laneId) ?? [];
    list.push(card);
    cardsByLane.set(laneId, list);
  }

  const lanes: RoadmapLane[] = [];
  const emptyCells = (): Record<RoadmapHorizon, RoadmapCard[]> => ({ now: [], next: [], later: [] });
  const fill = (lane: RoadmapLane, cards: RoadmapCard[]) => {
    for (const card of sortCards(cards)) {
      if (card.horizon === "done") lane.done.push(card);
      else lane.cells[card.horizon].push(card);
    }
    lane.total = cards.length;
  };

  // A goal earns a row while it is running, or as long as work still points
  // at it: a closed goal with open tasks is a fact worth a row, an empty
  // closed goal is history.
  for (const { goal, depth } of orderGoals(goals)) {
    const cards = cardsByLane.get(goal.id) ?? [];
    if (!goal.active && cards.length === 0) continue;
    const lane: RoadmapLane = { id: goal.id, goal, depth, cells: emptyCells(), done: [], total: 0 };
    fill(lane, cards);
    lanes.push(lane);
  }
  const unassigned = cardsByLane.get(ROADMAP_UNASSIGNED_LANE) ?? [];
  if (unassigned.length > 0) {
    const lane: RoadmapLane = { id: ROADMAP_UNASSIGNED_LANE, goal: null, depth: 0, cells: emptyCells(), done: [], total: 0 };
    fill(lane, unassigned);
    lanes.push(lane);
  }

  return {
    rules_version: ROADMAP_RULES_VERSION,
    today,
    done_window_days: layout.done_window_days,
    north_star: northStar,
    columns: ROADMAP_HORIZONS.map((id) => ({ id, label: ROADMAP_HORIZON_LABELS[id] })),
    lanes,
  };
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, med: 2, low: 3 };

/** Pressing first, then the sooner deadline, then the freshest edit. */
function sortCards(cards: RoadmapCard[]): RoadmapCard[] {
  return [...cards].sort((a, b) => {
    const rank = (PRIORITY_RANK[a.priority ?? ""] ?? 4) - (PRIORITY_RANK[b.priority ?? ""] ?? 4);
    if (rank !== 0) return rank;
    if (a.due_date !== b.due_date) {
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return a.due_date.localeCompare(b.due_date);
    }
    return b.updated_at.localeCompare(a.updated_at);
  });
}
