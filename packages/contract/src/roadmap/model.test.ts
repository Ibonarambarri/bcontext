import { describe, expect, it } from "vitest";
import type { KnowledgeNode, NodeEdge } from "../types.js";
import { normalizeViewPresentation } from "../views/schema.js";
import { buildRoadmap, roadmapHorizon, ROADMAP_UNASSIGNED_LANE } from "./model.js";

const TODAY = "2026-09-11";
const stamp = "2026-09-10T10:00:00.000Z";

function node(id: string, patch: Partial<KnowledgeNode> = {}): KnowledgeNode {
  return {
    id,
    workspace_id: "ws-1",
    parent_id: null,
    kind: "task",
    slug: id,
    title: id,
    content_md: "",
    data: {},
    tags: [],
    status: "todo",
    priority: null,
    assignee_id: null,
    due_date: null,
    position: 0,
    created_by: null,
    created_at: stamp,
    updated_at: stamp,
    ...patch,
  };
}

function goal(id: string, patch: Partial<KnowledgeNode> = {}, data: Record<string, unknown> = {}): KnowledgeNode {
  return node(id, {
    kind: "goal",
    status: "on_track",
    due_date: "2026-12-31",
    data: { scope: "company", timeframe: { start: "2026-10-01", cycle: "2026-Q4" }, ...data },
    ...patch,
  });
}

const edge = (from: string, to: string, relation: string): NodeEdge => ({ from_node: from, to_node: to, relation });
const opts = { today: TODAY, doneWindowDays: 30 };

describe("roadmapHorizon", () => {
  it("reads the live statuses", () => {
    expect(roadmapHorizon(node("a", { status: "in_progress" }), [], opts)).toBe("now");
    expect(roadmapHorizon(node("a", { status: "review" }), [], opts)).toBe("now");
    expect(roadmapHorizon(node("a", { status: "todo", priority: "high" }), [], opts)).toBe("now");
    expect(roadmapHorizon(node("a", { status: "todo" }), [], opts)).toBe("next");
    expect(roadmapHorizon(node("a", { status: "backlog", priority: "urgent" }), [], opts)).toBe("next");
    expect(roadmapHorizon(node("a", { status: "backlog" }), [], opts)).toBe("later");
    expect(roadmapHorizon(node("a", { status: null }), [], opts)).toBe("later");
    expect(roadmapHorizon(node("a", { status: "archived" }), [], opts)).toBeNull();
  });

  it("puts blocked work behind its blockers", () => {
    const inFlight = node("b", { status: "in_progress" });
    const waiting = node("c", { status: "backlog" });
    expect(roadmapHorizon(node("a", { status: "todo", priority: "urgent" }), [inFlight], opts)).toBe("next");
    expect(roadmapHorizon(node("a", { status: "todo" }), [inFlight, waiting], opts)).toBe("later");
    expect(roadmapHorizon(node("a", { status: "blocked" }), [], opts)).toBe("later");
  });

  it("keeps done inside the window and drops older done", () => {
    expect(roadmapHorizon(node("a", { status: "done", updated_at: "2026-09-01T00:00:00Z" }), [], opts)).toBe("done");
    expect(roadmapHorizon(node("a", { status: "done", updated_at: "2026-07-01T00:00:00Z" }), [], opts)).toBeNull();
  });
});

describe("buildRoadmap", () => {
  const northStar = goal("ns", { title: "North Star", due_date: null }, { root: true, timeframe: null });
  const company = goal("g-company", { parent_id: "ns", title: "Ship the beta" }, {
    key_results: [{ id: "kr1", name: "orgs", baseline: 0, target: 10, current: 5, direction: "increase" }],
  });
  const project = goal("g-project", { parent_id: "g-company", title: "Onboarding" }, { scope: "project" });
  const closed = goal("g-old", { parent_id: "ns", title: "Last quarter", due_date: "2026-06-30" }, {
    timeframe: { start: "2026-04-01", cycle: "2026-Q2" },
  });

  const items = [
    node("t1", { title: "Guide", status: "in_progress" }),
    node("t2", { title: "Emails", status: "todo", priority: "high" }),
    node("t3", { title: "Pricing", status: "backlog" }),
    node("t4", { title: "Loose end", status: "todo" }),
    node("t5", { title: "Shipped", status: "done", updated_at: "2026-09-05T00:00:00Z" }),
    node("t6", { title: "Waits on guide", status: "todo", priority: "urgent" }),
  ];
  const edges = [
    edge("t1", "g-project", "contributes_to"),
    edge("t2", "g-project", "contributes_to"),
    edge("t3", "g-company", "contributes_to"),
    edge("t5", "g-company", "contributes_to"),
    edge("t6", "g-company", "contributes_to"),
    edge("t6", "g-project", "contributes_to"),
    edge("t6", "t1", "blocked_by"),
  ];

  it("rows are goals in tree order, columns are horizons, cards follow contributes_to", () => {
    const model = buildRoadmap({ goals: [northStar, company, project, closed], items, index: items, edges, today: TODAY });
    expect(model.north_star?.id).toBe("ns");
    expect(model.columns.map((column) => column.id)).toEqual(["now", "next", "later"]);
    expect(model.lanes.map((lane) => [lane.id, lane.depth])).toEqual([
      ["g-company", 0],
      ["g-project", 1],
      [ROADMAP_UNASSIGNED_LANE, 0],
    ]);
    const companyLane = model.lanes[0]!;
    expect(companyLane.goal?.cycle).toBe("2026-Q4");
    expect(companyLane.goal?.progress).toBe(0.5);
    expect(companyLane.cells.later.map((card) => card.id)).toEqual(["t3"]);
    // t6 contributes to two goals: the first edge wins, and its open blocker
    // in `now` puts it in `next` with the blocker named.
    expect(companyLane.cells.next.map((card) => card.id)).toEqual(["t6"]);
    expect(companyLane.cells.next[0]?.blocked_by).toEqual(["Guide"]);
    expect(companyLane.done.map((card) => card.id)).toEqual(["t5"]);
    const projectLane = model.lanes[1]!;
    expect(projectLane.cells.now.map((card) => card.id)).toEqual(["t2", "t1"]);
    expect(model.lanes[2]!.cells.next.map((card) => card.id)).toEqual(["t4"]);
  });

  it("drops a closed goal with no work but keeps one that still has cards", () => {
    const stillOpen = [...edges, edge("t4", "g-old", "contributes_to")];
    const model = buildRoadmap({ goals: [northStar, company, project, closed], items, index: items, edges: stillOpen, today: TODAY });
    const lane = model.lanes.find((candidate) => candidate.id === "g-old");
    expect(lane?.goal?.active).toBe(false);
    expect(lane?.cells.next.map((card) => card.id)).toEqual(["t4"]);
    expect(model.lanes.some((candidate) => candidate.id === ROADMAP_UNASSIGNED_LANE)).toBe(false);
  });

  it("honours the done window from the presentation", () => {
    const presentation = normalizeViewPresentation({
      schema_version: 1,
      renderer: "roadmap",
      layout: { roadmap: { done_window_days: 3 } },
    });
    const model = buildRoadmap({ goals: [northStar, company], items, index: items, edges, today: TODAY, presentation });
    expect(model.done_window_days).toBe(3);
    expect(model.lanes[0]!.done).toEqual([]);
  });

  it("gives orphan goals a row when there is no North Star", () => {
    const model = buildRoadmap({ goals: [company, project], items, index: items, edges, today: TODAY });
    expect(model.north_star).toBeNull();
    expect(model.lanes.map((lane) => lane.id)).toEqual(["g-company", "g-project", ROADMAP_UNASSIGNED_LANE]);
  });
});
