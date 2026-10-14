import { describe, it, expect } from "vitest";
import {
  expandHitsWith1Hop,
  isExpandedHit,
  type ExpandEdge,
  type ExpandNode,
} from "./graph-expand";
import type { RagHit } from "@/lib/rag";

const node = (
  id: string,
  overrides: Partial<ExpandNode> = {},
): ExpandNode => ({
  id,
  parent_id: null,
  kind: "doc",
  title: `Node ${id}`,
  content_md: `Body of ${id}`,
  ...overrides,
});

const hit = (id: string, similarity = 1, chunk_index: number | null = 0): RagHit => ({
  node_id: id,
  title: `Node ${id}`,
  kind: "doc",
  content: `Body of ${id}`,
  similarity,
  chunk_index,
  block_id: null,
});

describe("expandHitsWith1Hop", () => {
  it("returns nothing when there are no hits", () => {
    expect(expandHitsWith1Hop([], [], [])).toEqual([]);
  });

  it("expands a seed's parent and tags the relation", () => {
    const nodes = [node("seed", { parent_id: "p1" }), node("p1")];
    const out = expandHitsWith1Hop([hit("seed")], nodes, []);
    expect(out).toHaveLength(1);
    expect(out[0]!.node_id).toBe("p1");
    expect(out[0]!.relation).toBe("parent");
    expect(out[0]!.expanded).toBe(true);
    expect(out[0]!.via).toBe("seed");
  });

  it("expands a seed's children", () => {
    const nodes = [
      node("seed"),
      node("c1", { parent_id: "seed" }),
      node("c2", { parent_id: "seed" }),
    ];
    const out = expandHitsWith1Hop([hit("seed")], nodes, []);
    const ids = out.map((h) => h.node_id).sort();
    expect(ids).toEqual(["c1", "c2"]);
    expect(out.every((h) => h.relation === "child")).toBe(true);
  });

  it("follows typed edges in both directions and surfaces the relation", () => {
    const nodes = [node("seed"), node("dec1"), node("bug1")];
    const edges: ExpandEdge[] = [
      { from_node: "seed", to_node: "dec1", relation: "decided_by" },
      { from_node: "bug1", to_node: "seed", relation: "blocks" },
    ];
    const out = expandHitsWith1Hop([hit("seed")], nodes, edges);
    const byId = new Map(out.map((h) => [h.node_id, h]));
    expect(byId.get("dec1")?.relation).toBe("decided_by");
    expect(byId.get("bug1")?.relation).toBe("blocks");
  });

  it("dedupes against existing hits", () => {
    const nodes = [node("seed"), node("dec1")];
    const edges: ExpandEdge[] = [
      { from_node: "seed", to_node: "dec1", relation: "decided_by" },
    ];
    // dec1 is already a direct hit — should not be expanded again.
    const out = expandHitsWith1Hop([hit("seed"), hit("dec1")], nodes, edges);
    expect(out.map((h) => h.node_id)).not.toContain("dec1");
  });

  it("does not double-add the same neighbor reached via different edges", () => {
    const nodes = [node("seed"), node("n1")];
    const edges: ExpandEdge[] = [
      { from_node: "seed", to_node: "n1", relation: "relates_to" },
      { from_node: "n1", to_node: "seed", relation: "linked_from" },
    ];
    const out = expandHitsWith1Hop([hit("seed")], nodes, edges);
    expect(out).toHaveLength(1);
    expect(out[0]!.node_id).toBe("n1");
  });

  it("attributes a multi-seed neighbor to the strongest seed", () => {
    const nodes = [
      node("a"),
      node("b"),
      node("shared", { parent_id: "a" }),
    ];
    const edges: ExpandEdge[] = [
      { from_node: "b", to_node: "shared", relation: "references" },
    ];
    // a scores higher than b, so the parent relation should win.
    const out = expandHitsWith1Hop([hit("a", 0.9), hit("b", 0.5)], nodes, edges);
    expect(out).toHaveLength(1);
    expect(out[0]!.via).toBe("a");
    expect(out[0]!.relation).toBe("child");
  });

  it("applies the score decay and produces a null chunk_index", () => {
    const nodes = [node("seed"), node("kid", { parent_id: "seed" })];
    const out = expandHitsWith1Hop([hit("seed", 0.8)], nodes, [], {
      scoreDecay: 0.25,
    });
    expect(out[0]!.similarity).toBeCloseTo(0.2, 4);
    expect(out[0]!.chunk_index).toBeNull();
  });

  it("truncates expanded content to the preview budget", () => {
    const big = "x".repeat(5000);
    const nodes = [
      node("seed"),
      node("kid", { parent_id: "seed", content_md: big }),
    ];
    const out = expandHitsWith1Hop([hit("seed")], nodes, [], {
      contentPreviewChars: 100,
    });
    expect(out[0]!.content.length).toBe(100);
  });

  it("respects topN — only expands the first N hits", () => {
    const nodes = [
      node("h1"),
      node("h2"),
      node("h3"),
      node("kid1", { parent_id: "h1" }),
      node("kid3", { parent_id: "h3" }),
    ];
    const out = expandHitsWith1Hop(
      [hit("h1", 1), hit("h2", 0.8), hit("h3", 0.6)],
      nodes,
      [],
      { topN: 2 },
    );
    const ids = out.map((h) => h.node_id);
    expect(ids).toContain("kid1");
    expect(ids).not.toContain("kid3");
  });

  it("caps the expanded list at maxExpanded", () => {
    const seed = node("seed");
    const kids = Array.from({ length: 10 }, (_, i) =>
      node(`k${i}`, { parent_id: "seed" }),
    );
    const out = expandHitsWith1Hop([hit("seed")], [seed, ...kids], [], {
      maxExpanded: 3,
    });
    expect(out).toHaveLength(3);
  });

  it("ignores edges that reference unknown nodes", () => {
    const nodes = [node("seed")];
    const edges: ExpandEdge[] = [
      { from_node: "seed", to_node: "ghost", relation: "phantom" },
    ];
    expect(expandHitsWith1Hop([hit("seed")], nodes, edges)).toEqual([]);
  });

  it("isExpandedHit narrows correctly", () => {
    const nodes = [node("seed"), node("kid", { parent_id: "seed" })];
    const out = expandHitsWith1Hop([hit("seed")], nodes, []);
    const base = hit("seed");
    expect(isExpandedHit(out[0]!)).toBe(true);
    expect(isExpandedHit(base)).toBe(false);
  });

  it("drops outside neighbors in strict scope", () => {
    const nodes = [node("seed"), node("inside"), node("outside")];
    const edges: ExpandEdge[] = [
      { from_node: "seed", to_node: "inside", relation: "references" },
      { from_node: "seed", to_node: "outside", relation: "references" },
    ];
    const out = expandHitsWith1Hop([hit("seed")], nodes, edges, {
      allowedNodeIds: new Set(["seed", "inside"]),
      scopeMode: "strict",
    });
    expect(out.map((row) => row.node_id)).toEqual(["inside"]);
    expect(out[0]?.expansion_scope).toBe("inside_scope");
  });

  it("marks outside neighbors when broad expansion is requested", () => {
    const nodes = [node("seed"), node("outside")];
    const out = expandHitsWith1Hop(
      [hit("seed")],
      nodes,
      [{ from_node: "seed", to_node: "outside", relation: "references" }],
      { allowedNodeIds: new Set(["seed"]), scopeMode: "broad" },
    );
    expect(out[0]?.expansion_scope).toBe("outside_scope");
  });
});
