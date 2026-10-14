import { describe, expect, it } from "vitest";
import type { KnowledgeNode, WorkspaceTag } from "../types.js";
import { normalizeViewPresentation, normalizeViewQuery } from "../views/schema.js";
import {
  boardColumns,
  boardMovePatch,
  buildBoardBlockers,
  deriveBoardCreate,
  groupBoardNodes,
} from "./model.js";

const stamp = "2026-07-18T10:00:00.000Z";
const tag = (id: string): WorkspaceTag => ({
  id,
  workspace_id: "ws-1",
  name: id[0]!.toUpperCase() + id.slice(1),
  normalized_name: id,
  slug: id,
  description: null,
  merged_into_id: null,
  deleted_at: null,
  created_at: stamp,
  updated_at: stamp,
});
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
const presentation = (patch: Record<string, unknown> = {}) => normalizeViewPresentation({
  schema_version: 1,
  renderer: "board",
  group_by: "status",
  ...patch,
});
const query = (patch: Record<string, unknown> = {}) => normalizeViewQuery({ schema_version: 1, ...patch });

describe("board renderer model", () => {
  it("groups canonical nodes once using configurable group_by and deterministic sorting", () => {
    const nodes = [
      node("low", { priority: "low", position: 2 }),
      node("urgent", { priority: "urgent", position: 1 }),
      node("urgent", { priority: "urgent", position: 1 }),
    ];
    const options = {
      query: query({ kinds: ["task", "bug"] }),
      presentation: presentation({ group_by: "priority", sort_by: [{ field: "title", direction: "asc" }] }),
      nodes,
    };
    expect(boardColumns(options).map((column) => column.value)).toEqual(["urgent", "high", "med", "low", "none"]);
    expect(groupBoardNodes(options).get("urgent")?.map((item) => item.id)).toEqual(["urgent"]);
    expect(groupBoardNodes(options).get("low")?.map((item) => item.id)).toEqual(["low"]);
  });

  it("builds guarded drag/drop patches without mutating the canonical node", () => {
    const original = node("a", { status: "todo", data: { source: "linear" } });
    const columns = boardColumns({ query: query(), presentation: presentation(), nodes: [original] });
    expect(boardMovePatch(original, "status", "review", columns)).toEqual({ status: "review" });
    expect(original.status).toBe("todo");
    expect(boardMovePatch(original, "source", "github", columns)).toEqual({ data: { source: "github" } });
    expect(original.data).toEqual({ source: "linear" });
  });

  it("derives filtered creates from scope, tags, source and the target status column without category", () => {
    const product = tag("product");
    const parent = node("parent", { kind: "doc", status: null, tags: [product] });
    const result = deriveBoardCreate({
      query: query({ kinds: ["task"], tags_all: ["product"], source: ["linear"], root_node_ids: [parent.id] }),
      presentation: presentation(),
      nodes: [],
      allNodes: [parent],
    }, "in_progress", "Ship it");
    expect(result).toEqual({
      ok: true,
      input: {
        title: "Ship it",
        kind: "task",
        parent_id: parent.id,
        content_md: "",
        status: "in_progress",
        data: { source: "linear" },
        tag_ids: [product.id],
        navigate: false,
      },
    });
  });

  it("uses a semantic view root as the create parent", () => {
    const parent = node("parent", { kind: "doc", status: null });
    const result = deriveBoardCreate({
      query: query({ kinds: ["task"], root_node_ids: [parent.id] }),
      presentation: presentation({ layout: { create_parent_id: parent.id } }),
      nodes: [],
      allNodes: [parent],
    }, "todo");
    expect(result).toMatchObject({ ok: true, input: { parent_id: parent.id } });
  });

  it("rejects creates that cannot safely inherit ambiguous active filters", () => {
    const result = deriveBoardCreate({
      query: query({ kinds: ["task"], tags_any: ["product", "tech"] }),
      presentation: presentation(),
      nodes: [],
    }, "todo");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/tag column/i);
  });

  it("reports active and completed typed blockers independently of status grouping", () => {
    const nodes = [node("task"), node("open", { status: "in_progress" }), node("done", { status: "done" })];
    expect(buildBoardBlockers(nodes, [
      { from_node: "task", to_node: "open", relation: "blocked_by" },
      { from_node: "task", to_node: "done", relation: "blocked_by" },
      { from_node: "task", to_node: "done", relation: "references" },
    ])).toEqual({ task: { total: 2, active: 1 } });
  });
});
