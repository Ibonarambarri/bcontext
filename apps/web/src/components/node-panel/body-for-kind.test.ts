import { describe, expect, it } from "vitest";
import { NODE_KINDS } from "@bcontext-dev/contract/types";
import { PLANNED_KINDS, panelBodyIsProse, panelPlanFor } from "./body-for-kind";

describe("panel plan by kind", () => {
  it("covers every kind in the contract, and nothing else", () => {
    expect([...PLANNED_KINDS].sort()).toEqual([...NODE_KINDS].sort());
    for (const kind of NODE_KINDS) expect(panelPlanFor(kind)).toBeDefined();
  });

  it("gives work kinds the work body with status, priority, dependencies and subtasks", () => {
    for (const kind of ["task", "bug"] as const) {
      expect(panelPlanFor(kind)).toEqual({
        body: "work",
        status: "task",
        priority: true,
        dependencies: true,
        subtasks: true,
      });
    }
  });

  it("keeps the goal vocabulary away from everything that is not a goal", () => {
    for (const kind of NODE_KINDS) {
      expect(panelPlanFor(kind).status === "goal").toBe(kind === "goal");
    }
  });

  it("lets a decision be closed, but never prioritised like a task", () => {
    for (const kind of ["decision", "adr"] as const) {
      const plan = panelPlanFor(kind);
      expect(plan.body).toBe("markdown");
      expect(plan.status).toBe("task");
      expect(plan.priority).toBe(false);
    }
  });

  it("gives the structured kinds their own body", () => {
    expect(panelPlanFor("data").body).toBe("data");
    expect(panelPlanFor("credential").body).toBe("credential");
    expect(panelPlanFor("meeting").body).toBe("meeting");
    expect(panelPlanFor("skill").body).toBe("skill");
    expect(panelPlanFor("entity").body).toBe("entity");
    expect(panelPlanFor("goal").body).toBe("goal");
  });

  it("knows which bodies carry the prose editor", () => {
    expect(panelBodyIsProse("markdown")).toBe(true);
    expect(panelBodyIsProse("skill")).toBe(true);
    expect(panelBodyIsProse("data")).toBe(false);
    expect(panelBodyIsProse("credential")).toBe(false);
  });
});
