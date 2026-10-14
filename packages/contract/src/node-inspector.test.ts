import { describe, expect, it } from "vitest";
import {
  buildInspectorRelations,
  blockIdFromHash,
  fullNodeUrl,
  inspectorCanWrite,
  inspectorLayoutForWidth,
  inspectorSelectionUrl,
  nodeFreshness,
  parseInspectorSelection,
  shouldRefreshInspector,
  descendantIds,
} from "./node-inspector.js";
import type { KnowledgeNode } from "./types.js";

function node(id: string, overrides: Partial<KnowledgeNode> = {}): KnowledgeNode {
  return {
    id,
    workspace_id: "ws",
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
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("node inspector selection and deep links", () => {
  it("round-trips canonical selection while preserving view context", () => {
    const url = inspectorSelectionUrl(
      "/w/acme/views/tasks",
      "?group=status&inspect=old",
      { nodeId: "node-1", blockId: "acceptance-criteria" },
    );
    expect(url).toBe(
      "/w/acme/views/tasks?group=status&inspect=node-1&block=acceptance-criteria",
    );
    expect(parseInspectorSelection(url.split("?")[1] ?? "")).toEqual({
      nodeId: "node-1",
      blockId: "acceptance-criteria",
    });
    expect(inspectorSelectionUrl("/w/acme", "?inspect=node-1&block=x", { nodeId: null, blockId: null }))
      .toBe("/w/acme");
  });

  it("opens the exact H2 in the full editor and carries a return route", () => {
    const href = fullNodeUrl({
      workspace: "acme/docs",
      nodeId: "node-1",
      blockId: "acceptance-criteria",
      returnTo: "/w/acme/docs/views/tasks?group=status&inspect=node-1",
    });
    expect(href).toContain("/w/acme/docs/n/node-1?");
    expect(href).toContain("return_to=%2Fw%2Facme%2Fdocs%2Fviews%2Ftasks");
    expect(href.endsWith("#acceptance-criteria")).toBe(true);
    expect(blockIdFromHash("#acceptance-criteria")).toBe("acceptance-criteria");
    expect(blockIdFromHash("#why%20now")).toBe("why now");
  });
});

describe("node inspector relations, permissions, realtime and responsive", () => {
  it("resolves typed dependencies once for every inspector renderer", () => {
    const task = node("task");
    const blocker = node("blocker", { title: "Blocker", status: "done" });
    const related = node("related", { kind: "doc", status: null });
    const result = buildInspectorRelations(task, [task, blocker, related], [
      { from_node: "task", to_node: "blocker", relation: "blocked_by" },
      { from_node: "related", to_node: "task", relation: "references" },
    ]);
    expect(result.dependencies.unblocked).toBe(true);
    expect(result.dependencies.blocked_by[0]).toMatchObject({ node_id: "blocker", done: true });
    // An archived blocker is out of the way too: nothing further happens to it.
    const archived = buildInspectorRelations(task, [task, { ...blocker, status: "archived" }, related], [
      { from_node: task.id, to_node: blocker.id, relation: "blocked_by" },
    ]);
    expect(archived.dependencies.blocked_by[0]).toMatchObject({ node_id: "blocker", done: true });
    expect(result.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ node_id: "related", direction: "incoming", relation: "references" }),
    ]));
  });

  it("derives read-only state from token scopes", () => {
    expect(inspectorCanWrite("user")).toBe(true);
    expect(inspectorCanWrite("agent", ["nodes:read"])).toBe(false);
    expect(inspectorCanWrite("agent_user", ["nodes:write"])).toBe(true);
    expect(inspectorCanWrite("agent", ["admin:*"])).toBe(true);
  });

  it("refreshes only the selected node and backlinks", () => {
    expect(shouldRefreshInspector("node.updated", { nodeId: "a" }, "a")).toBe(true);
    expect(shouldRefreshInspector("node.updated", { nodeId: "b" }, "a")).toBe(false);
    expect(shouldRefreshInspector("backlink.changed", { targetNodeId: "a", sourceNodeId: "b" }, "a")).toBe(true);
  });

  it("uses a drawer below the shell breakpoint and a rail otherwise", () => {
    expect(inspectorLayoutForWidth(390)).toBe("drawer");
    expect(inspectorLayoutForWidth(767)).toBe("drawer");
    expect(inspectorLayoutForWidth(768)).toBe("rail");
  });

  it("excludes self and descendants from editable parent candidates", () => {
    const nodes = [node("root", { kind: "doc" }), node("child", { kind: "task", parent_id: "root" }), node("grandchild", { parent_id: "child" }), node("other", { kind: "doc" })];
    expect([...descendantIds(nodes, "root")]).toEqual(expect.arrayContaining(["root", "child", "grandchild"]));
    expect(descendantIds(nodes, "root").has("other")).toBe(false);
  });

  it("labels freshness deterministically", () => {
    const now = new Date("2026-04-15T00:00:00.000Z").getTime();
    expect(nodeFreshness(node("a"), now)).toMatchObject({ state: "stale", age_days: 104 });
  });

  it("demotes staleness by one tier when the node was read recently (NEXO-05)", () => {
    const now = new Date("2026-04-15T00:00:00.000Z").getTime();
    const recentRead = new Date(now - 5 * 86_400_000).toISOString();
    expect(
      nodeFreshness(node("a"), now, { last_read_at: recentRead }),
    ).toMatchObject({ state: "aging" });
  });

  it("ignores a read activity signal outside the active window", () => {
    const now = new Date("2026-04-15T00:00:00.000Z").getTime();
    const staleRead = new Date(now - 90 * 86_400_000).toISOString();
    expect(
      nodeFreshness(node("a"), now, { last_read_at: staleRead }),
    ).toMatchObject({ state: "stale" });
  });
});
