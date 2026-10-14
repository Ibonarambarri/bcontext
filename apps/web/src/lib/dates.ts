/**
 * UTC calendar-day helpers shared by the overview dashboard and any surface
 * that reasons in whole days. UTC on purpose: `due_date` is a calendar date,
 * and a local-time midnight would shift it by a day for half the planet.
 */

const DAY_MS = 86_400_000;

/** Normalize any parseable date to a stable `YYYY-MM-DD` UTC calendar day. */
export function dayKey(value: string | Date): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`invalid date: ${String(value)}`);
  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}-${String(parsed.getUTCDate()).padStart(2, "0")}`;
}

export function addDays(value: string, days: number): string {
  const parsed = parseDay(value);
  if (parsed === null) throw new Error(`invalid date: ${value}`);
  return dayKey(new Date(parsed + days * DAY_MS));
}

/** Signed whole days from `from` to `to` (negative when `to` is earlier); 0 for bad input. */
export function daysBetween(from: string, to: string): number {
  const a = parseDay(from);
  const b = parseDay(to);
  if (a === null || b === null) return 0;
  return Math.round((b - a) / DAY_MS);
}

function parseDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
  if (!match) return null;
  const result = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const check = new Date(result);
  return check.getUTCFullYear() === Number(match[1]) && check.getUTCMonth() === Number(match[2]) - 1 && check.getUTCDate() === Number(match[3])
    ? result
    : null;
}
