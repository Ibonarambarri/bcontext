/**
 * How a goal READS. The arithmetic and the rules live in
 * `@bcontext-dev/contract/goals` — `resolveTimeframe`, `goalProgress`,
 * `keyResultProgress` — and are never restated here; this module only turns
 * what they return into the strings and tones the UI paints, so the page,
 * the floating panel and the lists cannot describe the same goal differently.
 *
 * Two rules the whole surface depends on:
 *   - Progress is `null` when nothing is measurable. That is "—", never 0%:
 *     a goal with no key results has not made zero progress, it has made
 *     unknown progress, and rounding that to a full-width empty bar is a
 *     claim the data does not support.
 *   - The horizon's END is the node's `due_date` column and its START is
 *     `data.timeframe.start`; `cycle` is a LABEL derived from that range,
 *     never an independent field. Everything here goes through
 *     `resolveTimeframe` so a hand-written cycle and a hand-written range
 *     can never disagree on screen.
 */
import { resolveTimeframe, type GoalData, type KeyResult } from "@bcontext-dev/contract/goals";
import type { GoalStatus } from "@bcontext-dev/contract/types";

/** Health, ordered as it degrades and then as it ends. */
export const GOAL_STATUSES: GoalStatus[] = [
  "on_track",
  "at_risk",
  "off_track",
  "achieved",
  "missed",
  "abandoned",
];

/**
 * The dot beside a goal's health, in the same hues the task statuses already
 * use — a goal is a different vocabulary, not a different palette. The two
 * ends of the story are quiet: a missed or abandoned goal is history, and
 * history does not need to shout on a list of live work.
 */
export const GOAL_STATUS_DOT: Record<GoalStatus, string> = {
  on_track: "#5f83c7",
  at_risk: "#d99a3d",
  off_track: "#d46464",
  achieved: "#62966d",
  missed: "#a06a6a",
  abandoned: "var(--ink-mute)",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2027-03-31` → `31 Mar 2027`, or `31 Mar` when the year is already said. */
function formatDay(iso: string, withYear = true): string {
  const [year, month, day] = iso.slice(0, 10).split("-");
  const monthName = MONTHS[Number(month) - 1];
  if (!year || !monthName || !day) return iso;
  const dayNumber = String(Number(day));
  return withYear ? `${dayNumber} ${monthName} ${year}` : `${dayNumber} ${monthName}`;
}

export interface GoalHorizon {
  start: string | null;
  end: string | null;
  /** The cycle label the range earned, e.g. `2027-Q1`. Null when it is not a quarter. */
  cycle: string | null;
  /** What to print: the cycle when there is one, else the range. Null when there is no horizon at all. */
  label: string | null;
  /** The range spelled out, always — the cycle's tooltip and its second line. */
  range: string | null;
}

/**
 * The one place a goal's horizon becomes words.
 *
 * A cycle wins the headline because `2027-Q1` is what people say out loud,
 * but the range it resolves to is always carried alongside: the label is
 * derived, so the dates are what is actually true and the UI should be able
 * to show both without asking twice.
 */
export function goalHorizon(data: GoalData, dueDate: string | null | undefined): GoalHorizon {
  const resolved = resolveTimeframe({
    cycle: data.timeframe?.cycle ?? null,
    start: data.timeframe?.start ?? null,
    end: dueDate ?? null,
  });
  const { start, end, cycle } = resolved;
  let range: string | null = null;
  if (start && end) {
    const sameYear = start.slice(0, 4) === end.slice(0, 4);
    range = `${formatDay(start, !sameYear)} – ${formatDay(end)}`;
  } else if (end) {
    range = `Until ${formatDay(end)}`;
  } else if (start) {
    range = `From ${formatDay(start)}`;
  }
  return { start, end, cycle, range, label: cycle ?? range };
}

const DAY_MS = 86_400_000;

/**
 * How much of the horizon is left, in the words a status line wants. Null
 * when the goal has no end date — an open-ended objective is not "overdue",
 * it simply has no clock.
 */
export function goalHorizonRemaining(
  end: string | null,
  today = new Date().toISOString().slice(0, 10),
): string | null {
  if (!end) return null;
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
  if (Number.isNaN(days)) return null;
  if (days === 0) return "Ends today";
  if (days > 0) return days === 1 ? "1 day left" : `${days} days left`;
  const over = Math.abs(days);
  return over === 1 ? "Ended 1 day ago" : `Ended ${over} days ago`;
}

/** A 0..1 fraction as a percentage, or "—" when there was nothing to measure. */
export function formatGoalProgress(progress: number | null): string {
  return progress === null ? "—" : `${Math.round(progress * 100)}%`;
}

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** `1.2k MRR` style value — the number, then its unit when it has one. */
export function formatKeyResultValue(value: number, unit: string | null | undefined): string {
  const formatted = NUMBER.format(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

/** "12 → 40 users": where the key result started, where it is going. */
export function keyResultTargetLabel(kr: Pick<KeyResult, "baseline" | "target" | "unit" | "direction">): string {
  if (kr.direction === "maintain") return `hold ${formatKeyResultValue(kr.target, kr.unit)}`;
  return `${NUMBER.format(kr.baseline)} → ${formatKeyResultValue(kr.target, kr.unit)}`;
}

/**
 * The scope, as the UI says it. Read straight off `data` and never re-derived
 * from tags or edges: scope is decided once, at creation, and a tag added in
 * an unrelated cleanup must not be able to demote a company goal.
 */
export function goalScopeLabel(data: GoalData): string | null {
  if (data.root === true) return "North Star";
  if (data.scope === "company") return "Company";
  if (data.scope === "project") return "Project";
  return null;
}
