import { describe, expect, it } from "vitest";
import type { GoalData } from "@bcontext-dev/contract/goals";
import {
  GOAL_STATUSES,
  GOAL_STATUS_DOT,
  formatGoalProgress,
  formatKeyResultValue,
  goalHorizon,
  goalHorizonRemaining,
  goalScopeLabel,
  keyResultTargetLabel,
} from "./presentation";

describe("goal horizon", () => {
  it("prefers the cycle as the headline but keeps the range it resolves to", () => {
    // The cycle is a LABEL over a range. Showing only the label would hide
    // the dates that are actually true, and showing only the dates would lose
    // the word people say out loud.
    const horizon = goalHorizon({ timeframe: { start: null, cycle: "2027-Q1" } }, null);
    expect(horizon.label).toBe("2027-Q1");
    expect(horizon.start).toBe("2027-01-01");
    expect(horizon.end).toBe("2027-03-31");
    expect(horizon.range).toBe("1 Jan – 31 Mar 2027");
  });

  it("derives the cycle when explicit dates happen to land on a quarter", () => {
    const horizon = goalHorizon({ timeframe: { start: "2027-01-01", cycle: null } }, "2027-03-31");
    expect(horizon.cycle).toBe("2027-Q1");
  });

  it("falls back to the range when the dates are not a quarter", () => {
    const horizon = goalHorizon({ timeframe: { start: "2026-10-15", cycle: null } }, "2026-11-20");
    expect(horizon.cycle).toBeNull();
    expect(horizon.label).toBe("15 Oct – 20 Nov 2026");
  });

  it("spells the year on both ends when the horizon crosses one", () => {
    const horizon = goalHorizon({ timeframe: { start: "2026-11-01", cycle: null } }, "2027-01-31");
    expect(horizon.label).toBe("1 Nov 2026 – 31 Jan 2027");
  });

  it("reads the end off due_date, never off data", () => {
    // The END is the node's own column, which is what makes a goal's deadline
    // work with everything that already filters by due_date.
    expect(goalHorizon({}, "2027-03-31").label).toBe("Until 31 Mar 2027");
    expect(goalHorizon({ timeframe: { start: "2027-01-01", cycle: null } }, null).label)
      .toBe("From 1 Jan 2027");
    expect(goalHorizon({}, null).label).toBeNull();
  });
});

describe("goal horizon remaining", () => {
  it("counts the days either side of the end, and says nothing without one", () => {
    expect(goalHorizonRemaining("2026-09-20", "2026-09-09")).toBe("11 days left");
    expect(goalHorizonRemaining("2026-09-10", "2026-09-09")).toBe("1 day left");
    expect(goalHorizonRemaining("2026-09-09", "2026-09-09")).toBe("Ends today");
    expect(goalHorizonRemaining("2026-09-08", "2026-09-09")).toBe("Ended 1 day ago");
    expect(goalHorizonRemaining(null, "2026-09-09")).toBeNull();
  });
});

describe("goal progress formatting", () => {
  it("shows nothing measurable as an em dash, never as 0%", () => {
    // A goal with no key results has not made zero progress — it has made
    // unknown progress, and an empty bar is a claim the data cannot support.
    expect(formatGoalProgress(null)).toBe("—");
    expect(formatGoalProgress(0)).toBe("0%");
    expect(formatGoalProgress(0.6234)).toBe("62%");
    expect(formatGoalProgress(1)).toBe("100%");
  });
});

describe("key result labels", () => {
  it("reads a directional key result as the distance it has to cover", () => {
    expect(keyResultTargetLabel({ baseline: 12, target: 40, unit: "users", direction: "increase" }))
      .toBe("12 → 40 users");
    expect(keyResultTargetLabel({ baseline: 900, target: 300, unit: "ms", direction: "decrease" }))
      .toBe("900 → 300 ms");
  });

  it("reads a maintain key result as a floor to hold, not a distance", () => {
    expect(keyResultTargetLabel({ baseline: 99, target: 99.9, unit: "%", direction: "maintain" }))
      .toBe("hold 99.9 %");
  });

  it("omits the unit when there is none", () => {
    expect(formatKeyResultValue(1234, null)).toBe("1,234");
    expect(formatKeyResultValue(1234, "EUR")).toBe("1,234 EUR");
  });
});

describe("goal scope", () => {
  it("reads scope off data and never re-derives it", () => {
    expect(goalScopeLabel({ scope: "company" })).toBe("Company");
    expect(goalScopeLabel({ scope: "project" })).toBe("Project");
    // The North Star wins over its own scope: there is at most one per
    // workspace and it is the thing you want named.
    expect(goalScopeLabel({ scope: "company", root: true })).toBe("North Star");
    const unset: GoalData = {};
    expect(goalScopeLabel(unset)).toBeNull();
  });
});

describe("goal health palette", () => {
  it("gives every health a dot, so no goal falls through to the neutral one", () => {
    for (const status of GOAL_STATUSES) {
      expect(GOAL_STATUS_DOT[status], `no dot for "${status}"`).toBeTruthy();
    }
  });
});
