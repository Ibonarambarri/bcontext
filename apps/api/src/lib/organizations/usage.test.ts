import { describe, expect, it } from "vitest";

import {
  aggregateActivity,
  aggregateMcpCalls,
  periodStart,
  type ActivityRow,
} from "./usage";

const row = (
  workspace_id: string,
  verb: string,
  actor_kind: string,
): ActivityRow => ({ workspace_id, verb, actor_kind });

describe("aggregateActivity", () => {
  it("counts nothing for an empty month", () => {
    const totals = aggregateActivity([]);
    expect(totals).toMatchObject({
      nodes_created: 0,
      nodes_edited: 0,
      writes_by_people: 0,
      writes_by_agents: 0,
    });
    expect(totals.by_workspace.size).toBe(0);
  });

  it("splits writes between the people and the agents they connected", () => {
    const totals = aggregateActivity([
      row("w1", "created", "human"),
      row("w1", "created", "agent"),
      row("w1", "updated", "agent"),
      row("w1", "deleted", "agent"),
    ]);
    expect(totals.writes_by_people).toBe(1);
    expect(totals.writes_by_agents).toBe(3);
  });

  it("leaves actor_kind='system' out of both sides of the split", () => {
    // Migrations and backfills wrote these. Crediting them to people would
    // claim work no person did; crediting them to agents would inflate the
    // one number the tab exists to make honest.
    const totals = aggregateActivity([
      row("w1", "created", "human"),
      row("w1", "created", "system"),
      row("w1", "updated", "system"),
    ]);
    expect(totals.writes_by_people).toBe(1);
    expect(totals.writes_by_agents).toBe(0);
    // …but the nodes are really there, so they still count as work done.
    expect(totals.nodes_created).toBe(2);
    expect(totals.nodes_edited).toBe(1);
  });

  it("treats renames and moves as edits, and deletions as neither", () => {
    const totals = aggregateActivity([
      row("w1", "created", "human"),
      row("w1", "updated", "human"),
      row("w1", "renamed", "human"),
      row("w1", "moved", "human"),
      row("w1", "deleted", "human"),
    ]);
    expect(totals.nodes_created).toBe(1);
    expect(totals.nodes_edited).toBe(3);
    // The deletion is work, so it is in the actor split, and in nothing else.
    expect(totals.writes_by_people).toBe(5);
  });

  it("ignores verbs that are not writes", () => {
    const totals = aggregateActivity([
      row("w1", "commented", "human"),
      row("w1", "linked", "agent"),
      row("w1", "read", "agent"),
    ]);
    expect(totals.writes_by_people).toBe(0);
    expect(totals.writes_by_agents).toBe(0);
    expect(totals.by_workspace.size).toBe(0);
  });

  it("keeps created/edited per workspace while the actor split stays org-wide", () => {
    const totals = aggregateActivity([
      row("w1", "created", "human"),
      row("w1", "updated", "agent"),
      row("w2", "created", "agent"),
      row("w2", "created", "agent"),
    ]);
    expect(totals.by_workspace.get("w1")).toEqual({ created: 1, edited: 1 });
    expect(totals.by_workspace.get("w2")).toEqual({ created: 2, edited: 0 });
    expect(totals.nodes_created).toBe(3);
    expect(totals.writes_by_agents).toBe(3);
    expect(totals.writes_by_people).toBe(1);
  });
});

describe("aggregateMcpCalls", () => {
  it("totals per tool and per workspace, busiest tool first", () => {
    const { usage, by_workspace } = aggregateMcpCalls([
      { workspace_id: "w1", tool: "nodes", calls: 40 },
      { workspace_id: "w2", tool: "nodes", calls: 5 },
      { workspace_id: "w1", tool: "ping", calls: 7 },
    ]);
    expect(usage.total).toBe(52);
    expect(usage.by_tool).toEqual([
      { tool: "nodes", calls: 45 },
      { tool: "ping", calls: 7 },
    ]);
    expect(by_workspace.get("w1")).toBe(47);
    expect(by_workspace.get("w2")).toBe(5);
  });

  it("is empty rather than absent when nothing called MCP", () => {
    expect(aggregateMcpCalls([]).usage).toEqual({ total: 0, by_tool: [] });
  });
});

describe("periodStart", () => {
  it("starts the YYYY-MM bucket at the first UTC instant of the month", () => {
    expect(periodStart("2026-09")).toBe("2026-09-01T00:00:00.000Z");
    expect(periodStart("2026-01")).toBe("2026-01-01T00:00:00.000Z");
  });
});
