// Goal nodes — the shape of `data` on a `goal`, and the pure helpers both
// sides use. Kept here rather than in either app so the cycle/range rules and
// the "is this strategic?" predicate have exactly one definition.

import type { KnowledgeNode, NodeKind } from "./types.js";

/**
 * Where a goal sits. Inferred ONCE at creation (no parent and nothing it
 * contributes to ⇒ company) and then persisted: re-deriving it on read would
 * let a tag added in an unrelated cleanup silently demote a company goal.
 */
export type GoalScope = "company" | "project";

export type KeyResultDirection = "increase" | "decrease" | "maintain";

export interface KeyResult {
  id: string;
  name: string;
  unit?: string | null;
  baseline: number;
  target: number;
  current: number;
  direction: KeyResultDirection;
}

/**
 * The window a goal is measured over. The END lives in the node's `due_date`
 * column, not here: reusing it means a goal's deadline already works with
 * everything that filters by that column.
 *
 * `cycle` is a LABEL, never the truth — a cycle *is* a range (`2027-Q1` is
 * `2027-01-01 → 2027-03-31`), so storing both as independent fields would
 * admit contradictions with no way to say which wins. Write either one;
 * `resolveTimeframe` reduces both to the range plus a derived label.
 */
export interface GoalTimeframe {
  start: string | null;
  cycle: string | null;
}

/** Conventions for `data` on a node of kind `goal`. */
export interface GoalData {
  scope?: GoalScope;
  /** The workspace's North Star. At most one per workspace (enforced in SQL). */
  root?: boolean;
  timeframe?: GoalTimeframe | null;
  key_results?: KeyResult[];
  review_every?: "weekly" | "monthly" | "quarterly";
  last_reviewed_at?: string | null;
}

const CYCLE_PATTERN = /^(\d{4})-Q([1-4])$/;
const QUARTER_ENDS = ["03-31", "06-30", "09-30", "12-31"] as const;

/** `2027-Q1` → `{ start: "2027-01-01", end: "2027-03-31" }`; null if unparseable. */
export function cycleToRange(cycle: string): { start: string; end: string } | null {
  const match = CYCLE_PATTERN.exec(cycle.trim());
  if (!match) return null;
  const [, year, quarter] = match;
  const index = Number(quarter) - 1;
  const startMonth = String(index * 3 + 1).padStart(2, "0");
  return { start: `${year}-${startMonth}-01`, end: `${year}-${QUARTER_ENDS[index]}` };
}

/** The cycle label a range earns by landing exactly on a quarter, else null. */
export function rangeToCycle(start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  const year = start.slice(0, 4);
  for (let index = 0; index < 4; index++) {
    const candidate = `${year}-Q${index + 1}`;
    const range = cycleToRange(candidate);
    if (range && range.start === start && range.end === end) return candidate;
  }
  return null;
}

/**
 * The single place a horizon is decided. Callers may write a cycle, a pair of
 * dates, or nothing; what comes back is always the range, with the label
 * filled in when the dates happen to be a quarter.
 */
export function resolveTimeframe(input: {
  cycle?: string | null;
  start?: string | null;
  end?: string | null;
}): { start: string | null; end: string | null; cycle: string | null } {
  if (input.cycle) {
    const range = cycleToRange(input.cycle);
    if (range) return { ...range, cycle: input.cycle.trim() };
  }
  const start = input.start ?? null;
  const end = input.end ?? null;
  return { start, end, cycle: rangeToCycle(start, end) };
}

/**
 * How far a key result has come, 0..1. `null` when the question is malformed
 * (baseline === target leaves nothing to measure), so callers show "—"
 * instead of a fake 0% or a division by zero.
 *
 * `maintain` reads its target as a floor to hold, not a distance to cover.
 */
export function keyResultProgress(kr: Pick<KeyResult, "baseline" | "target" | "current" | "direction">): number | null {
  if (kr.direction === "maintain") return kr.current >= kr.target ? 1 : 0;
  const span = kr.direction === "increase" ? kr.target - kr.baseline : kr.baseline - kr.target;
  if (span === 0) return null;
  const covered = kr.direction === "increase" ? kr.current - kr.baseline : kr.baseline - kr.current;
  return Math.min(1, Math.max(0, covered / span));
}

/** Mean progress across the measurable key results; null when none are. */
export function goalProgress(keyResults: readonly KeyResult[] | undefined): number | null {
  const measurable = (keyResults ?? [])
    .map((kr) => keyResultProgress(kr))
    .filter((value): value is number => value !== null);
  if (!measurable.length) return null;
  return measurable.reduce((sum, value) => sum + value, 0) / measurable.length;
}

/**
 * The predicate the `goals:write` verb is built on: the North Star and every
 * company-level goal. Project goals stay under the ordinary `write` verb, so
 * an agent working on a feature can open its own objective without a new
 * grant. One definition, because the permission seam and the tool surface
 * disagreeing about this would be a hole, not a bug.
 */
export function isStrategicGoal(node: { kind: NodeKind; data?: Record<string, unknown> | null }): boolean {
  if (node.kind !== "goal") return false;
  const data = (node.data ?? {}) as GoalData;
  return data.root === true || data.scope === "company";
}

/** Read `data` off a node as goal data. Returns an empty shape for other kinds. */
export function goalData(node: Pick<KnowledgeNode, "kind" | "data">): GoalData {
  return node.kind === "goal" ? ((node.data ?? {}) as GoalData) : {};
}

/**
 * Is the goal running today? Answered by OVERLAP with the range, never by the
 * cycle label — a goal written with explicit dates from 15 Oct to 20 Nov must
 * still answer "what was in flight in Q4" even though nobody ever labelled it.
 */
export function isGoalActive(
  node: Pick<KnowledgeNode, "kind" | "data" | "due_date">,
  today = new Date().toISOString().slice(0, 10),
): boolean {
  if (node.kind !== "goal") return false;
  const start = goalData(node).timeframe?.start ?? null;
  if (start && today < start) return false;
  if (node.due_date && today > node.due_date) return false;
  return true;
}
