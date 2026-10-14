/**
 * Goals on the server: what a goal is decided to be when it is created, and
 * what a check-in does to it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import type { Storage } from "@/lib/storage";
import { goalData, isStrategicGoal } from "@bcontext-dev/contract/goals";
import {
  CONTRIBUTES_TO,
  findNorthStar,
  goalCreateInput,
  goalHealth,
  indexGoalPressure,
  readGoals,
  reviewStatus,
  updateGoal,
  writeGoalOp,
} from "@/lib/goals";

let storage: Storage;

async function create(
  title: string,
  base: Partial<Parameters<typeof goalCreateInput>[1]> = {},
  extra: Parameters<typeof goalCreateInput>[2] = {},
) {
  return storage.createNode(
    await goalCreateInput(
      storage,
      { title, kind: "goal", parent_id: null, status: "on_track", ...base },
      extra,
    ),
  );
}

beforeEach(async () => {
  const slug = `goals-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  createWorkspace({ name: "Goals", slug });
  storage = resolveDemoStorage(slug)!;
});

describe("what a goal is decided to be, once", () => {
  it("makes a goal with nothing above it a company goal, and hangs it off the North Star", async () => {
    const ns = await create("Be the context layer", { data: { root: true } });
    expect(goalData(ns).scope).toBe("company");
    expect(ns.parent_id).toBeNull();
    expect((await findNorthStar(storage))?.id).toBe(ns.id);

    const goal = await create("Triple revenue");
    expect(goalData(goal).scope).toBe("company");
    expect(goal.parent_id).toBe(ns.id);
    expect(isStrategicGoal(goal)).toBe(true);
  });

  it("makes a goal that answers to something else a project goal", async () => {
    const company = await create("Triple revenue");
    const under = await create("Ship self-serve billing", { parent_id: company.id });
    expect(goalData(under).scope).toBe("project");
    expect(isStrategicGoal(under)).toBe(false);

    const contributor = await create("Cut onboarding to a day", {}, { contributes_to: company.id });
    expect(goalData(contributor).scope).toBe("project");
    // Nothing above it in the hierarchy, but it is not the company's own goal.
    expect(contributor.parent_id).toBeNull();
  });

  it("persists the scope, so a link added later cannot demote a company goal", async () => {
    const company = await create("Triple revenue");
    const other = await create("Be the context layer", { data: { root: true } });
    await storage.createEdge({ from_node: company.id, to_node: other.id, relation: CONTRIBUTES_TO });

    const reread = await storage.getNode(company.id);
    expect(goalData(reread!).scope).toBe("company");
    expect(isStrategicGoal(reread!)).toBe(true);
  });

  it("takes an explicit scope over what it would have inferred", async () => {
    const goal = await create("A team objective", { data: { scope: "project" } });
    expect(goalData(goal).scope).toBe("project");
    expect(goal.parent_id).toBeNull();
  });
});

describe("the horizon", () => {
  it("stores a cycle as its two ends: due_date and data.timeframe.start", async () => {
    const goal = await create("Q1", {}, { horizon: { cycle: "2027-Q1" } });
    expect(goal.due_date).toBe("2027-03-31");
    expect(goalData(goal).timeframe).toEqual({ start: "2027-01-01", cycle: "2027-Q1" });
  });

  it("labels a pair of dates only when they are exactly a quarter", async () => {
    const quarter = await create("Same window", {}, { horizon: { start: "2027-04-01", end: "2027-06-30" } });
    expect(goalData(quarter).timeframe?.cycle).toBe("2027-Q2");

    const odd = await create("Six weeks", {}, { horizon: { start: "2027-10-15", end: "2027-11-20" } });
    expect(goalData(odd).timeframe?.cycle).toBeNull();
    expect(odd.due_date).toBe("2027-11-20");
  });

  it("moves one end without erasing the other", async () => {
    const goal = await create("Q1", {}, { horizon: { cycle: "2027-Q1" } });
    const { node } = await updateGoal(storage, goal.id, { horizon: { end: "2027-04-30" } });
    expect(node.due_date).toBe("2027-04-30");
    expect(goalData(node).timeframe?.start).toBe("2027-01-01");
    // No longer a quarter, so the label goes rather than lying.
    expect(goalData(node).timeframe?.cycle).toBeNull();
  });
});

describe("checking in on one key result", () => {
  const keyResults = [
    { name: "MRR", unit: "EUR", baseline: 10_000, target: 30_000, direction: "increase" as const },
    { name: "Churn", unit: "%", baseline: 6, target: 3, direction: "decrease" as const },
  ];

  it("moves one number and leaves the body and the other key results alone", async () => {
    const goal = await create(
      "Triple revenue",
      { content_md: "## Why now\n\nBecause the market is moving." },
      { key_results: keyResults, horizon: { cycle: "2027-Q1" } },
    );
    const [mrr, churn] = goalData(goal).key_results!;

    const res = await writeGoalOp(storage, goal.id, {
      op: "checkin",
      key_result_id: mrr!.id,
      current: 20_000,
      status: "at_risk",
    });

    expect(res.key_result?.current).toBe(20_000);
    expect(res.node.content_md).toBe(goal.content_md);
    expect(res.node.status).toBe("at_risk");
    expect(res.key_results.find((kr) => kr.id === churn!.id)?.current).toBe(6);
    // Halfway on one, nothing on the other: the goal is at 25%.
    expect(goalData(res.node).key_results).toHaveLength(2);
    expect(goalData(res.node).last_reviewed_at).toBeTruthy();
  });

  it("does not need if_updated_at, and honours it when given", async () => {
    const goal = await create("Triple revenue", {}, { key_results: keyResults });
    const [mrr] = goalData(goal).key_results!;

    // Somebody else renames the goal between the read and the check-in.
    await storage.updateNode(goal.id, { title: "Triple revenue by Q1" });
    const unpinned = await writeGoalOp(storage, goal.id, { op: "checkin", key_result_id: mrr!.id, current: 15_000 });
    expect(unpinned.key_result?.current).toBe(15_000);

    // Pinned to a read that is definitely stale: the guard is honoured rather
    // than retried, because the caller said their read was the contract.
    await expect(
      writeGoalOp(
        storage,
        goal.id,
        { op: "checkin", key_result_id: mrr!.id, current: 16_000 },
        { ifUpdatedAt: "1999-01-01T00:00:00.000Z" },
      ),
    ).rejects.toThrow(/conflict|modified/i);
  });

  it("says which key results exist when the id is wrong", async () => {
    const goal = await create("Triple revenue", {}, { key_results: keyResults });
    await expect(
      writeGoalOp(storage, goal.id, { op: "checkin", key_result_id: "nope", current: 1 }),
    ).rejects.toThrow(/MRR/);
  });

  it("adds, edits and drops one key result without re-sending the rest", async () => {
    const goal = await create("Triple revenue", {}, { key_results: keyResults });
    const added = await writeGoalOp(storage, goal.id, {
      op: "add_kr",
      kr: { name: "Logos", baseline: 4, target: 12, direction: "increase" },
    });
    expect(added.key_results).toHaveLength(3);

    const edited = await writeGoalOp(storage, goal.id, {
      op: "update_kr",
      key_result_id: added.key_result!.id,
      kr: { target: 20 },
    });
    expect(edited.key_result?.target).toBe(20);
    expect(edited.key_result?.name).toBe("Logos");

    const removed = await writeGoalOp(storage, goal.id, { op: "remove_kr", key_result_id: added.key_result!.id });
    expect(removed.key_results.map((kr) => kr.name)).toEqual(["MRR", "Churn"]);
  });

  it("refuses to work on a node that is not a goal", async () => {
    const task = await storage.createNode({ title: "A task", kind: "task", parent_id: null });
    await expect(
      writeGoalOp(storage, task.id, { op: "checkin", key_result_id: "k1", current: 1 }),
    ).rejects.toThrow(/not a goal/);
  });
});

describe("how a goal is doing", () => {
  it("calls a goal behind when its progress trails the time it has spent", async () => {
    const goal = await create(
      "Triple revenue",
      {},
      {
        horizon: { start: "2027-01-01", end: "2027-03-31" },
        key_results: [{ name: "MRR", baseline: 0, target: 100, current: 10, direction: "increase" }],
      },
    );
    const health = goalHealth(goal, "2027-03-01");
    expect(health.progress).toBeCloseTo(0.1);
    expect(health.elapsed).toBeGreaterThan(0.6);
    expect(health.pace).toBe("behind");
    expect(health.active).toBe(true);
  });

  it("leaves pace unsaid when there is nothing to compare", async () => {
    const undated = await create("Someday", { data: { scope: "project" } });
    expect(goalHealth(undated, "2027-03-01").pace).toBeNull();
    expect(goalHealth(undated, "2027-03-01").progress).toBeNull();
  });
});

describe("reading the tree", () => {
  it("nests project goals under the company goals under the North Star", async () => {
    const ns = await create("Be the context layer", { data: { root: true } }, { horizon: { cycle: "2027-Q1" } });
    const company = await create("Triple revenue", {}, { horizon: { cycle: "2027-Q1" } });
    await create("Ship billing", { parent_id: company.id }, { horizon: { cycle: "2027-Q1" } });

    const read = await readGoals(storage, { today: "2027-02-01" });
    expect(read.north_star?.id).toBe(ns.id);
    expect(read.tree).toHaveLength(1);
    expect(read.tree[0]!.children.map((c) => c.title)).toEqual(["Triple revenue"]);
    expect(read.tree[0]!.children[0]!.children.map((c) => c.title)).toEqual(["Ship billing"]);
    expect(read.total).toBe(3);
  });

  it("leaves closed windows out unless asked, and never drops the North Star", async () => {
    const ns = await create("Be the context layer", { data: { root: true } }, { horizon: { cycle: "2026-Q1" } });
    await create("Last quarter", { parent_id: ns.id }, { horizon: { cycle: "2026-Q1" } });

    const current = await readGoals(storage, { today: "2027-02-01" });
    expect(current.total).toBe(1);
    expect(current.north_star?.id).toBe(ns.id);

    const all = await readGoals(storage, { today: "2027-02-01", include_inactive: true });
    expect(all.total).toBe(2);
  });

  it("filters by scope and status", async () => {
    await create("Be the context layer", { data: { root: true } });
    const company = await create("Triple revenue", { status: "at_risk" });
    await create("Ship billing", { parent_id: company.id, status: "on_track" });

    const projects = await readGoals(storage, { scope: "project" });
    expect(projects.flat.map((g) => g.title)).toEqual(["Ship billing"]);
    const atRisk = await readGoals(storage, { status: "at_risk" });
    expect(atRisk.flat.map((g) => g.title)).toEqual(["Triple revenue"]);
  });

  it("reports contributes_to as edges rather than nesting them", async () => {
    const company = await create("Triple revenue");
    const contributor = await create("Cut onboarding", {}, { contributes_to: company.id });
    await storage.createEdge({ from_node: contributor.id, to_node: company.id, relation: CONTRIBUTES_TO });

    const read = await readGoals(storage);
    const card = read.flat.find((g) => g.id === contributor.id)!;
    expect(card.contributes_to).toEqual([company.id]);
    expect(card.children).toEqual([]);
  });
});

describe("which goal pulls on a piece of work", () => {
  const today = "2027-02-01";
  const window = { horizon: { start: "2027-01-01", end: "2027-03-31" } };

  it("carries urgency up the chain and reports the goal it came from", async () => {
    const company = await create("Triple revenue", { status: "at_risk" }, window);
    const project = await create("Ship billing", { parent_id: company.id, status: "on_track" }, window);
    const task = await storage.createNode({ title: "Wire it", kind: "task", parent_id: null, status: "todo" });
    await storage.createEdge({ from_node: task.id, to_node: project.id, relation: CONTRIBUTES_TO });

    const nodes = await storage.listNodes({ limit: 100 });
    const pressure = indexGoalPressure(nodes.filter((n) => n.kind === "goal"), await storage.listEdges(), nodes, today);

    // The project goal is fine; the company goal it hangs under is not, and
    // that is what the task inherits.
    expect(pressure.get(task.id)?.goal_id).toBe(company.id);
    expect(pressure.get(task.id)?.urgency).toBeGreaterThan(0.5);
    expect(pressure.get(project.id)?.goal_id).toBe(company.id);
  });

  it("gives a healthy, achieved or finished goal no pull at all", async () => {
    const healthy = await create("On track", { status: "on_track" }, window);
    const won = await create("Already achieved", { status: "achieved" }, window);
    const nodes = await storage.listNodes({ limit: 100 });
    const pressure = indexGoalPressure(nodes.filter((n) => n.kind === "goal"), await storage.listEdges(), nodes, today);
    expect(pressure.get(healthy.id)?.urgency).toBe(0);
    expect(pressure.get(won.id)?.urgency).toBe(0);
  });

  it("ignores a goal whose window has closed", async () => {
    const past = await create("Last quarter, and it went badly", { status: "off_track" }, {
      horizon: { start: "2026-01-01", end: "2026-03-31" },
    });
    const nodes = await storage.listNodes({ limit: 100 });
    const pressure = indexGoalPressure(nodes.filter((n) => n.kind === "goal"), await storage.listEdges(), nodes, today);
    expect(pressure.get(past.id)?.urgency).toBe(0);
  });

  it("terminates on a cycle instead of hanging the brief", async () => {
    const a = await create("A", { status: "off_track" }, window);
    const b = await create("B", { status: "on_track" }, window);
    await storage.createEdge({ from_node: a.id, to_node: b.id, relation: CONTRIBUTES_TO });
    await storage.createEdge({ from_node: b.id, to_node: a.id, relation: CONTRIBUTES_TO });

    const nodes = await storage.listNodes({ limit: 100 });
    const pressure = indexGoalPressure(nodes.filter((n) => n.kind === "goal"), await storage.listEdges(), nodes, today);
    expect(pressure.get(a.id)?.urgency).toBeGreaterThan(0);
    expect(pressure.get(b.id)).toBeDefined();
  });

  it("weighs a company goal above a project one in the same trouble", async () => {
    const company = await create("Company", { status: "at_risk", data: { scope: "company" } }, window);
    const project = await create("Project", { status: "at_risk", data: { scope: "project" } }, window);
    const nodes = await storage.listNodes({ limit: 100 });
    const pressure = indexGoalPressure(nodes.filter((n) => n.kind === "goal"), await storage.listEdges(), nodes, today);
    expect(pressure.get(company.id)!.urgency).toBeGreaterThan(pressure.get(project.id)!.urgency);
  });
});

describe("the review cadence a goal promised", () => {
  it("is overdue once more than the cadence has passed since the last check-in", async () => {
    const goal = await create("Triple revenue", {}, { review_every: "weekly" });
    const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const stale = { ...goal, data: { ...goal.data, last_reviewed_at: twoWeeksAgo } };
    const status = reviewStatus(stale);
    expect(status?.every).toBe("weekly");
    expect(status?.days_overdue).toBeGreaterThanOrEqual(6);

    const fresh = { ...goal, data: { ...goal.data, last_reviewed_at: new Date().toISOString() } };
    expect(reviewStatus(fresh)).toBeNull();
  });

  it("counts from creation for a goal that was never reviewed", async () => {
    const goal = await create("Triple revenue", {}, { review_every: "weekly" });
    const old = { ...goal, created_at: new Date(Date.now() - 30 * 86_400_000).toISOString() };
    expect(reviewStatus(old)?.last_reviewed_at).toBeNull();
    expect(reviewStatus(old)?.days_overdue).toBeGreaterThan(20);
  });

  it("never calls a goal overdue when it declared no cadence", async () => {
    const goal = await create("Triple revenue");
    const ancient = { ...goal, created_at: "2020-01-01T00:00:00.000Z" };
    expect(reviewStatus(ancient)).toBeNull();
  });
});
