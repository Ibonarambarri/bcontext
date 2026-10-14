import { describe, expect, it } from "vitest";
import { normalizeViewPresentation, normalizeViewQuery, VIEW_LIMITS } from "@bcontext-dev/contract/views/schema";
import { estimateQueryCost } from "./resolver";

describe("canonical view schema", () => {
  it("rejects unknown schema versions and mixed presentation fields", () => {
    expect(() => normalizeViewQuery({ schema_version: 2 })).toThrow();
    expect(() => normalizeViewQuery({ schema_version: 1, renderer: "graph" })).toThrow();
    expect(() => normalizeViewPresentation({ schema_version: 1, renderer: "list", kinds: ["doc"] })).toThrow();
  });

  it("normalizes set-like filters deterministically", () => {
    const a = normalizeViewQuery({
      schema_version: 1,
      kinds: ["task", "doc", "task"],
      tags_any: [" Product ", "business", "Product"],
      statuses: ["todo", "done", "todo"],
      root_node_ids: ["b", "a", "b"],
    });
    expect(a.kinds).toEqual(["doc", "task"]);
    expect(a.tags_any).toEqual(["business", "product"]);
    expect(a.statuses).toEqual(["done", "todo"]);
    expect(a.root_node_ids).toEqual(["a", "b"]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(normalizeViewQuery(a)));
  });

  it("carries unblocked as an explicit boolean, off unless asked", () => {
    expect(normalizeViewQuery({ schema_version: 1 }).unblocked).toBe(false);
    expect(normalizeViewQuery({ schema_version: 1, unblocked: true }).unblocked).toBe(true);
    expect(() => normalizeViewQuery({ schema_version: 1, unblocked: "yes" })).toThrow();
    // Every status fits in one filter — `include_archived` on list needs it.
    expect(VIEW_LIMITS.maxStatuses).toBe(7);
  });

  it("preserves semantic column/sort order while canonicalizing layout keys", () => {
    const presentation = normalizeViewPresentation({
      schema_version: 1,
      renderer: "table",
      columns: ["updated_at", "title", "updated_at"],
      sort_by: [{ field: "priority", direction: "desc" }, { field: "title", direction: "asc" }],
      layout: { z: { b: 1, a: 2 }, a: true },
    });
    expect(presentation.columns).toEqual(["updated_at", "title"]);
    expect(presentation.sort_by.map((sort) => sort.field)).toEqual(["priority", "title"]);
    expect(Object.keys(presentation.layout)).toEqual(["a", "z"]);
    expect(Object.keys(presentation.layout.z as object)).toEqual(["a", "b"]);
  });

  it("requires roots for traversal and enforces depth/size caps", () => {
    expect(() => normalizeViewQuery({ schema_version: 1, traversal: { depth: 1 } })).toThrow(/requires/);
    expect(() => normalizeViewQuery({ schema_version: 1, root_node_ids: ["a"], traversal: { depth: VIEW_LIMITS.maxTraversalDepth + 1 } })).toThrow();
    expect(() => normalizeViewQuery({ schema_version: 1, root_node_ids: ["a"], traversal: { depth: 1, max_nodes: VIEW_LIMITS.maxTraversalNodes + 1 } })).toThrow();
  });

  it("exposes a deterministic cost model with a hard rejectable ceiling", () => {
    const cheap = normalizeViewQuery({ schema_version: 1, root_node_ids: ["a"], traversal: { depth: 2, max_edges: 20, max_nodes: 20 } });
    const expensive = normalizeViewQuery({ schema_version: 1, root_node_ids: Array.from({ length: 50 }, (_, i) => String(i)), traversal: { depth: 3, max_edges: 2_000 } });
    expect(estimateQueryCost(cheap)).toBe(40);
    expect(estimateQueryCost(expensive)).toBeGreaterThan(VIEW_LIMITS.maxResolverCost);
  });
});
