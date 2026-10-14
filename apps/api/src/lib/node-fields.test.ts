import { describe, expect, it } from "vitest";
import {
  decodeNodeCursor,
  encodeNodeCursor,
  isNodeFieldPreset,
  paginateNodeSummaries,
  parseNodeFieldPreset,
  presetForRenderer,
  projectNodeSummary,
} from "@/lib/node-fields";
import type { NodeSummary, WorkspaceTag } from "@bcontext-dev/contract/types";

function tag(id: string): WorkspaceTag {
  return {
    id,
    workspace_id: "ws-1",
    name: `Tag ${id}`,
    normalized_name: `tag ${id}`,
    slug: `tag-${id}`,
    description: "long taxonomy description that list payloads must not ship",
    merged_into_id: null,
    deleted_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function summary(id: string, position: number): NodeSummary {
  return {
    id,
    workspace_id: "ws-1",
    parent_id: null,
    kind: "task",
    slug: `node-${id}`,
    title: `Node ${id}`,
    content_md: "",
    data: { source: "github" },
    tags: [tag("t1")],
    status: "todo",
    priority: "high",
    assignee_id: null,
    due_date: null,
    position,
    created_by: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    source: "github",
    subtasks: { done: 1, total: 3 },
  };
}

describe("node field presets", () => {
  it("maps renderers to their minimal preset", () => {
    expect(presetForRenderer("board")).toBe("board");
    expect(presetForRenderer("graph")).toBe("graph");
    expect(presetForRenderer("list")).toBe("list");
    expect(presetForRenderer("changes")).toBe("summary");
    expect(isNodeFieldPreset("board")).toBe(true);
    expect(isNodeFieldPreset("everything")).toBe(false);
  });

  it("keeps the retired timeline vocabulary working as list", () => {
    // Renderer retired 2026-07-21; stored views and older API clients may
    // still say "timeline" — both funnel into the list preset.
    expect(presetForRenderer("timeline")).toBe("list");
    expect(parseNodeFieldPreset("timeline")).toBe("list");
    expect(parseNodeFieldPreset("board")).toBe("board");
    expect(parseNodeFieldPreset("everything")).toBeNull();
    expect(isNodeFieldPreset("timeline")).toBe(false);
  });

  it("projects list rows without bodies, data or full tag records", () => {
    const projected = projectNodeSummary(summary("a", 1), "list");
    expect(projected).not.toHaveProperty("content_md");
    expect(projected).not.toHaveProperty("data");
    expect(projected).not.toHaveProperty("priority");
    expect(projected.tags).toEqual([{ id: "t1", name: "Tag t1", slug: "tag-t1" }]);
    expect(projected.title).toBe("Node a");
    expect(projected.kind).toBe("task");
    expect(projected.status).toBe("todo");
  });

  it("keeps board scheduling fields plus source, and graph structure fields", () => {
    const board = projectNodeSummary(summary("a", 1), "board");
    expect(board.priority).toBe("high");
    expect(board.source).toBe("github");
    expect(board.subtasks).toEqual({ done: 1, total: 3 });
    expect(board).toHaveProperty("due_date");
    expect(board).toHaveProperty("assignee_id");
    expect(board).not.toHaveProperty("content_md");
    const graph = projectNodeSummary(summary("a", 1), "graph");
    expect(graph).toHaveProperty("parent_id");
    expect(graph).not.toHaveProperty("priority");
    expect(graph).not.toHaveProperty("source");
    expect(graph).not.toHaveProperty("subtasks");
    expect(projectNodeSummary(summary("a", 1), "list")).not.toHaveProperty("subtasks");
  });

  it("returns the untouched summary for the back-compat default", () => {
    const row = summary("a", 1);
    expect(projectNodeSummary(row, "summary")).toBe(row);
  });

  it("pages by keyset over (position, id) and terminates cleanly", () => {
    const rows = [summary("c", 3), summary("a", 1), summary("b", 2)];
    const first = paginateNodeSummaries(rows, { limit: 2 });
    expect(first.items.map((node) => node.id)).toEqual(["a", "b"]);
    expect(first.next_cursor).not.toBeNull();
    const second = paginateNodeSummaries(rows, {
      limit: 2,
      cursor: decodeNodeCursor(first.next_cursor!),
    });
    expect(second.items.map((node) => node.id)).toEqual(["c"]);
    expect(second.next_cursor).toBeNull();
  });

  it("round-trips cursors and rejects malformed ones", () => {
    const cursor = encodeNodeCursor({ position: 7, id: "n-7" });
    expect(decodeNodeCursor(cursor)).toEqual({ position: 7, id: "n-7" });
    expect(decodeNodeCursor("garbage")).toBeNull();
  });
});
