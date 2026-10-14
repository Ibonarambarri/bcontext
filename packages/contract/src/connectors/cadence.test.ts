import { describe, expect, it } from "vitest";
import { computeNextRun, cadenceLabel, type Cadence } from "./cadence.js";

describe("computeNextRun", () => {
  it("hourly: rounds up to the next top-of-hour boundary", () => {
    const now = new Date("2026-07-19T10:15:00.000Z");
    const next = computeNextRun({ mode: "hourly" }, now);
    expect(next.toISOString()).toBe("2026-07-19T11:00:00.000Z");
  });

  it("hourly: already at the boundary still advances a full hour", () => {
    const now = new Date("2026-07-19T10:00:00.000Z");
    const next = computeNextRun({ mode: "hourly" }, now);
    expect(next.toISOString()).toBe("2026-07-19T11:00:00.000Z");
  });

  it("daily: later today when the hour hasn't passed yet", () => {
    const now = new Date("2026-07-19T08:00:00.000Z");
    const next = computeNextRun({ mode: "daily", hour: 9 }, now);
    expect(next.toISOString()).toBe("2026-07-19T09:00:00.000Z");
  });

  it("daily: tomorrow when the hour already passed", () => {
    const now = new Date("2026-07-19T10:00:00.000Z");
    const next = computeNextRun({ mode: "daily", hour: 9 }, now);
    expect(next.toISOString()).toBe("2026-07-20T09:00:00.000Z");
  });

  it("weekly: next matching weekday", () => {
    // 2026-07-19 is a Sunday (day 0); next Monday (1) at 09:00 UTC.
    const now = new Date("2026-07-19T10:00:00.000Z");
    const next = computeNextRun({ mode: "weekly", day_of_week: 1, hour: 9 }, now);
    expect(next.toISOString()).toBe("2026-07-20T09:00:00.000Z");
  });

  it("weekly: same day but time already passed rolls to next week", () => {
    const now = new Date("2026-07-20T10:00:00.000Z"); // Monday, past 09:00
    const next = computeNextRun({ mode: "weekly", day_of_week: 1, hour: 9 }, now);
    expect(next.toISOString()).toBe("2026-07-27T09:00:00.000Z");
  });

  it("monthly: later this month when the day hasn't passed yet", () => {
    const now = new Date("2026-07-05T10:00:00.000Z");
    const next = computeNextRun({ mode: "monthly", day_of_month: 15, hour: 9 }, now);
    expect(next.toISOString()).toBe("2026-07-15T09:00:00.000Z");
  });

  it("monthly: next month when the day already passed", () => {
    const now = new Date("2026-07-19T10:00:00.000Z");
    const next = computeNextRun({ mode: "monthly", day_of_month: 15, hour: 9 }, now);
    expect(next.toISOString()).toBe("2026-08-15T09:00:00.000Z");
  });
});

describe("cadenceLabel", () => {
  it("labels every mode in English for the Ingestion UI", () => {
    const cases: [Cadence, string][] = [
      [{ mode: "hourly" }, "Hourly"],
      [{ mode: "daily", hour: 9 }, "Daily · 09:00 UTC"],
      [{ mode: "weekly", day_of_week: 1, hour: 9 }, "Weekly · Monday 09:00 UTC"],
      [{ mode: "monthly", day_of_month: 15, hour: 9 }, "Monthly · day 15 09:00 UTC"],
    ];
    for (const [cadence, expected] of cases) {
      expect(cadenceLabel(cadence)).toBe(expected);
    }
  });
});
