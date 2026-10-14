import { describe, expect, it } from "vitest";
import {
  ONBOARDING_STEP_IDS,
  onboardingCompleted,
  onboardingDismissedAt,
  onboardingSteps,
} from "./onboarding.js";

describe("onboarding contract", () => {
  it("orders the steps as the guide presents them, one per fact", () => {
    const steps = onboardingSteps({
      connect_agent: true,
      first_agent_write: false,
      ask_nexo: true,
      connect_integration: false,
    });
    expect(steps.map((s) => s.id)).toEqual([...ONBOARDING_STEP_IDS]);
    expect(steps.map((s) => s.done)).toEqual([true, false, true, false]);
  });

  it("is complete only when every step is done", () => {
    const all = onboardingSteps({
      connect_agent: true,
      first_agent_write: true,
      ask_nexo: true,
      connect_integration: true,
    });
    expect(onboardingCompleted(all)).toBe(true);
    expect(onboardingCompleted(all.map((s, i) => (i === 3 ? { ...s, done: false } : s)))).toBe(false);
    expect(onboardingCompleted([])).toBe(false);
  });

  it("reads the dismissal only when the metadata carries a real timestamp", () => {
    expect(onboardingDismissedAt(undefined)).toBeNull();
    expect(onboardingDismissedAt({})).toBeNull();
    expect(onboardingDismissedAt({ onboarding_dismissed_at: null })).toBeNull();
    expect(onboardingDismissedAt({ onboarding_dismissed_at: "yesterday" })).toBeNull();
    expect(onboardingDismissedAt({ onboarding_dismissed_at: 1 })).toBeNull();
    expect(onboardingDismissedAt({ onboarding_dismissed_at: "2026-09-11T02:00:00.000Z" })).toBe(
      "2026-09-11T02:00:00.000Z",
    );
  });
});
