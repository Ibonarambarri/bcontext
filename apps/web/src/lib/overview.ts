/**
 * The workspace dashboard's numbers, derived from the node list the page
 * already has. Pure functions over `KnowledgeNode[]` and a clock — no fetch,
 * no React — so the overview page (server) and its tests compute the same
 * lists. The windows below are the product's definition of "recent",
 * "upcoming" and "stale"; change them here, not in the renderer.
 */
import { addDays, dayKey, daysBetween } from "@/lib/dates";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";

const DAY_MS = 86_400_000;
const ATTENTION_WINDOW_DAYS = 7;
const UPCOMING_WINDOW_DAYS = 14;
const RECENT_WINDOW_DAYS = 7;
const STALE_DOC_WINDOW_DAYS = 30;
const WORK_KINDS = new Set(["task", "bug"]);
const CONTINUE_KINDS = new Set(["doc", "adr", "meeting", "skill", "entity"]);
const STALE_KINDS = new Set(["doc", "adr"]);
const AGING_KINDS = new Set(["doc", "adr", "meeting"]);
const PRIORITY_WEIGHT = { urgent: 0, high: 1, med: 2, low: 3 } as const;

/** One day of the 30-day activity chart on the workspace dashboard. */
export interface ActivityPoint {
  /** Short, locale-fixed label, e.g. "Jul 20". */
  date: string;
  /** Nodes created on this day. */
  created: number;
  /** Nodes updated on this day, excluding same-day creations (no double count). */
  updated: number;
}

interface OverviewPulse {
  changed: number;
  completed: number;
  decisions: number;
}

/** Everything the dashboard renders, already sliced and ordered. */
export interface OverviewModel {
  attention: KnowledgeNode[];
  upcoming: KnowledgeNode[];
  active: KnowledgeNode[];
  recent: KnowledgeNode[];
  decisions: KnowledgeNode[];
  continueWorking: KnowledgeNode[];
  /** doc/adr/meeting nodes with the oldest `updated_at`, oldest first. */
  aging: KnowledgeNode[];
  pulse: OverviewPulse;
  totals: {
    attention: number;
    upcoming: number;
    active: number;
    /** All nodes currently in the workspace graph. */
    total: number;
    /** Nodes created within the last `RECENT_WINDOW_DAYS`. */
    newNodes: number;
    /** Open task/bug work items with status "blocked". */
    blocked: number;
    /** doc/adr nodes not updated within `STALE_DOC_WINDOW_DAYS`. */
    staleDocs: number;
    /** % of doc/adr nodes updated within `STALE_DOC_WINDOW_DAYS` (100 when there are none). */
    freshKnowledgePercent: number;
  };
}

/** One pass over the workspace nodes into every dashboard section. */
export function buildOverviewModel(
  nodes: readonly KnowledgeNode[],
  now = new Date(),
): OverviewModel {
  const content = [...nodes];
  const openWork = content.filter(isOpenWork);
  const today = dayKey(now);
  const recentlyChanged = content.filter(
    (node) => Date.parse(node.updated_at) >= now.getTime() - RECENT_WINDOW_DAYS * DAY_MS,
  );

  const attention = openWork
    .filter((node) => {
      const days = daysUntilDue(node, today);
      return node.status === "blocked" || (days !== null && days <= ATTENTION_WINDOW_DAYS);
    })
    .sort((a, b) => compareAttention(a, b, today));

  const upcoming = openWork
    .filter((node) => {
      const days = daysUntilDue(node, today);
      return days !== null && days >= 0 && days <= UPCOMING_WINDOW_DAYS;
    })
    .sort((a, b) => compareDueDate(a, b) || comparePriority(a, b));

  const active = openWork
    .filter((node) => node.status === "in_progress" || node.status === "review")
    .sort((a, b) => comparePriority(a, b) || compareUpdated(a, b));

  const recent = [...content].sort(compareUpdated).slice(0, 5);
  const decisions = content
    .filter((node) => node.kind === "decision")
    .sort(compareUpdated)
    .slice(0, 5);
  const continueWorking = content
    .filter((node) => CONTINUE_KINDS.has(node.kind))
    .sort(compareUpdated)
    .slice(0, 5);

  const blocked = openWork.filter((node) => node.status === "blocked").length;
  const newNodes = content.filter(
    (node) => Date.parse(node.created_at) >= now.getTime() - RECENT_WINDOW_DAYS * DAY_MS,
  ).length;
  const staleKindNodes = content.filter((node) => STALE_KINDS.has(node.kind));
  const staleDocs = staleKindNodes.filter(
    (node) => Date.parse(node.updated_at) < now.getTime() - STALE_DOC_WINDOW_DAYS * DAY_MS,
  ).length;
  const freshKnowledgePercent = staleKindNodes.length === 0
    ? 100
    : Math.round(((staleKindNodes.length - staleDocs) / staleKindNodes.length) * 100);

  return {
    attention: attention.slice(0, 5),
    upcoming: upcoming.slice(0, 5),
    active: active.slice(0, 5),
    recent,
    decisions,
    continueWorking,
    aging: agingKnowledge(content),
    pulse: {
      changed: recentlyChanged.length,
      completed: recentlyChanged.filter(
        (node) => WORK_KINDS.has(node.kind) && node.status === "done",
      ).length,
      decisions: recentlyChanged.filter((node) => node.kind === "decision").length,
    },
    totals: {
      attention: attention.length,
      upcoming: upcoming.length,
      active: active.length,
      total: content.length,
      newNodes,
      blocked,
      staleDocs,
      freshKnowledgePercent,
    },
  };
}

/**
 * doc/adr/meeting nodes with the oldest `updated_at` first — the "aging
 * knowledge" list on the workspace dashboard.
 */
function agingKnowledge(nodes: readonly KnowledgeNode[], limit = 6): KnowledgeNode[] {
  return nodes
    .filter((node) => AGING_KINDS.has(node.kind))
    .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
    .slice(0, limit);
}

/**
 * Daily created/updated counts for the last `days` days (inclusive of today),
 * for the dashboard activity chart. A node updated the same day it was
 * created only counts toward `created`, never both, to avoid double-counting.
 */
export function activitySeries(
  nodes: readonly KnowledgeNode[],
  now = new Date(),
  days = 30,
): ActivityPoint[] {
  const createdByDay = new Map<string, number>();
  const updatedByDay = new Map<string, number>();
  for (const node of nodes) {
    const createdKey = safeDayKey(node.created_at);
    const updatedKey = safeDayKey(node.updated_at);
    if (createdKey) createdByDay.set(createdKey, (createdByDay.get(createdKey) ?? 0) + 1);
    if (updatedKey && updatedKey !== createdKey) {
      updatedByDay.set(updatedKey, (updatedByDay.get(updatedKey) ?? 0) + 1);
    }
  }

  const todayKey = dayKey(now);
  let cursor = addDays(todayKey, -(days - 1));
  const points: ActivityPoint[] = [];
  for (let i = 0; i < days; i++) {
    points.push({
      date: formatChartDay(cursor),
      created: createdByDay.get(cursor) ?? 0,
      updated: updatedByDay.get(cursor) ?? 0,
    });
    cursor = addDays(cursor, 1);
  }
  return points;
}

function safeDayKey(value: string): string | null {
  try {
    return dayKey(value);
  } catch {
    return null;
  }
}

function formatChartDay(key: string): string {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${key}T00:00:00.000Z`),
  );
}

/** Whole days from `today` to the node's due date; negative when overdue, null without one. */
export function daysUntilDue(
  node: Pick<KnowledgeNode, "due_date">,
  today = dayKey(new Date()),
): number | null {
  if (!node.due_date) return null;
  try {
    return daysBetween(today, dayKey(node.due_date));
  } catch {
    return null;
  }
}

function isOpenWork(node: KnowledgeNode): boolean {
  return WORK_KINDS.has(node.kind) && node.status !== "done";
}

function compareAttention(a: KnowledgeNode, b: KnowledgeNode, today: string): number {
  const aDays = daysUntilDue(a, today);
  const bDays = daysUntilDue(b, today);
  const aRank = attentionRank(a, aDays);
  const bRank = attentionRank(b, bDays);
  return aRank - bRank || (aDays ?? Number.MAX_SAFE_INTEGER) - (bDays ?? Number.MAX_SAFE_INTEGER) || comparePriority(a, b);
}

function attentionRank(node: KnowledgeNode, days: number | null): number {
  if (days !== null && days < 0) return 0;
  if (node.status === "blocked") return 1;
  return 2;
}

function compareDueDate(a: KnowledgeNode, b: KnowledgeNode): number {
  return (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999");
}

function comparePriority(a: KnowledgeNode, b: KnowledgeNode): number {
  const aWeight = a.priority ? PRIORITY_WEIGHT[a.priority] : 4;
  const bWeight = b.priority ? PRIORITY_WEIGHT[b.priority] : 4;
  return aWeight - bWeight;
}

function compareUpdated(a: KnowledgeNode, b: KnowledgeNode): number {
  return Date.parse(b.updated_at) - Date.parse(a.updated_at);
}
