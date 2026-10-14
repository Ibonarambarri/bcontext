/**
 * Per-connector ingest cadence: the shape stored in
 * `connector_installs.config.cadence`, its label for the Integrations hub, and
 * `computeNextRun`, the one rule for "when is the next slot". The API's
 * scheduler (`src/lib/connectors/scheduler.ts`, pg-boss job
 * `connector.schedule`) enqueues a `full_sync` when `config.next_run_at` is
 * due and advances it with the same function the web uses to preview it.
 */
import { z } from "zod";

export const CadenceSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("hourly") }),
  z.object({ mode: z.literal("daily"), hour: z.number().int().min(0).max(23) }),
  z.object({
    mode: z.literal("weekly"),
    day_of_week: z.number().int().min(0).max(6),
    hour: z.number().int().min(0).max(23),
  }),
  z.object({
    mode: z.literal("monthly"),
    day_of_month: z.number().int().min(1).max(28),
    hour: z.number().int().min(0).max(23),
  }),
]);

export type Cadence = z.infer<typeof CadenceSchema>;

/** Human label for the Integrations queue config UI, e.g. "Weekly · Monday 09:00 UTC". */
export function cadenceLabel(cadence: Cadence): string {
  const time = (hour: number) => `${String(hour).padStart(2, "0")}:00 UTC`;
  switch (cadence.mode) {
    case "hourly":
      return "Hourly";
    case "daily":
      return `Daily · ${time(cadence.hour)}`;
    case "weekly": {
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      return `Weekly · ${days[cadence.day_of_week]} ${time(cadence.hour)}`;
    }
    case "monthly":
      return `Monthly · day ${cadence.day_of_month} ${time(cadence.hour)}`;
  }
}

/**
 * Next UTC occurrence strictly after `now`, hand-rolled (no cron/date lib
 * in this repo — same spirit as `currentPeriod()` in organizations/meters).
 */
export function computeNextRun(cadence: Cadence, now: Date): Date {
  if (cadence.mode === "hourly") {
    const next = new Date(now);
    next.setUTCMinutes(0, 0, 0);
    next.setUTCHours(next.getUTCHours() + 1);
    return next;
  }

  if (cadence.mode === "daily") {
    const next = new Date(now);
    next.setUTCHours(cadence.hour, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }

  if (cadence.mode === "weekly") {
    const next = new Date(now);
    next.setUTCHours(cadence.hour, 0, 0, 0);
    let deltaDays = (cadence.day_of_week - next.getUTCDay() + 7) % 7;
    if (deltaDays === 0 && next <= now) deltaDays = 7;
    next.setUTCDate(next.getUTCDate() + deltaDays);
    return next;
  }

  // monthly
  const next = new Date(now);
  next.setUTCHours(cadence.hour, 0, 0, 0);
  next.setUTCDate(cadence.day_of_month);
  if (next <= now) {
    next.setUTCMonth(next.getUTCMonth() + 1);
    next.setUTCDate(cadence.day_of_month);
  }
  return next;
}
