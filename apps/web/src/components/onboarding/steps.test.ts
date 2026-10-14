import { describe, expect, it } from "vitest";
import { ONBOARDING_STEP_IDS } from "@bcontext-dev/contract/onboarding";
import { GUIDE_STEPS, anchorSelector, doneCount, firstPendingIndex, guideStep, guideViewHref } from "./steps";

describe("guide steps", () => {
  it("covers every API step, in the API's order, each with copy and an anchor", () => {
    expect(GUIDE_STEPS.map((s) => s.id)).toEqual([...ONBOARDING_STEP_IDS]);
    for (const step of GUIDE_STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.body.length).toBeGreaterThan(0);
      expect(step.action.length).toBeGreaterThan(0);
      expect(step.ticks).toMatch(/^Ticks itself/);
      expect(step.anchor).toMatch(/^[a-z]+-[a-z]+$/);
    }
    expect(new Set(GUIDE_STEPS.map((s) => s.anchor)).size).toBe(GUIDE_STEPS.length);
  });

  it("looks a step up by id and builds its selector", () => {
    const step = guideStep("connect_agent");
    expect(step.view).toBe("agents");
    expect(anchorSelector(step)).toBe('[data-tour="agents-add"]');
    expect(guideStep("first_agent_write").prompt).toBeTruthy();
  });

  it("sends each step to the page its control lives on", () => {
    const ws = { org: "acme", slug: "core" };
    expect(guideStep("connect_agent").anchor).toBe("agents-add");
    expect(guideStep("connect_integration").view).toBe("nexos");
    expect(guideStep("connect_integration").anchor).toBe("integrations-add");
    expect(guideStep("ask_nexo").view).toBe("nexo");
    expect(guideViewHref(ws, "agents")).toBe("/w/acme/core/v/agents");
    expect(guideViewHref(ws, "nexos")).toBe("/w/acme/core/nexos");
    expect(guideViewHref(ws, "nexo")).toBe("/w/acme/core/nexos/general");
    expect(guideViewHref(ws, "overview")).toBe("/w/acme/core");
  });

  it("opens the tour on the first pending step, or the first when all are done", () => {
    const steps = ONBOARDING_STEP_IDS.map((id) => ({ id, done: false }));
    expect(firstPendingIndex(steps)).toBe(0);
    steps[0]!.done = true;
    steps[1]!.done = true;
    expect(firstPendingIndex(steps)).toBe(2);
    for (const s of steps) s.done = true;
    expect(firstPendingIndex(steps)).toBe(0);
    expect(doneCount(steps)).toBe(4);
  });
});
