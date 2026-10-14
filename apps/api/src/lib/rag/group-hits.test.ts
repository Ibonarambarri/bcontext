import { describe, expect, it } from "vitest";
import { groupHitsByNode, refForHit, type RagHit } from "@/lib/rag";

function hit(partial: Partial<RagHit> & { node_id: string }): RagHit {
  return {
    title: "T",
    kind: "doc",
    content: "some matched content",
    similarity: 0.5,
    chunk_index: 0,
    block_id: null,
    ...partial,
  };
}

describe("groupHitsByNode", () => {
  it("collapses multi-block hits into one entry per node", () => {
    const hits = [
      hit({ node_id: "a", block_id: "vision", similarity: 0.9 }),
      hit({ node_id: "b", block_id: null, similarity: 0.8 }),
      hit({ node_id: "a", block_id: "risks", similarity: 0.7 }),
      hit({ node_id: "a", block_id: "_intro", similarity: 0.6 }),
    ];
    const groups = groupHitsByNode(hits);
    expect(groups.map((g) => g.node_id)).toEqual(["a", "b"]);
    expect(groups[0]!.score).toBe(0.9);
    expect(groups[0]!.blocks.map((b) => b.block_id)).toEqual([
      "vision",
      "risks",
      "_intro",
    ]);
    expect(groups[0]!.blocks[0]!.ref).toBe("/n/a#vision");
  });

  it("keeps node order by best-block rank of the incoming list", () => {
    const hits = [
      hit({ node_id: "x", similarity: 0.4 }),
      hit({ node_id: "y", similarity: 0.9 }), // y ranked lower by retriever despite score
    ];
    const groups = groupHitsByNode(hits);
    expect(groups.map((g) => g.node_id)).toEqual(["x", "y"]);
  });
});

describe("refForHit", () => {
  it("anchors to the block when known, node otherwise", () => {
    expect(refForHit({ node_id: "n1", block_id: "auth" })).toBe("/n/n1#auth");
    expect(refForHit({ node_id: "n1", block_id: null })).toBe("/n/n1");
  });
});
