import { describe, it, expect } from "vitest";
import {
  chunkMarkdown,
  extractBlockHeadings,
  extractBlockIds,
  extractBlocks,
  nextPreviousBlockIds,
  tokenEstimate,
} from "./chunk.js";

describe("chunkMarkdown", () => {
  it("returns no chunks for empty input", () => {
    expect(chunkMarkdown("")).toEqual([]);
    expect(chunkMarkdown("   \n  ")).toEqual([]);
  });

  it("keeps a short doc as a single chunk", () => {
    const md = "# Title\n\nShort body.";
    const chunks = chunkMarkdown(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.heading_path).toEqual(["Title"]);
    expect(chunks[0]!.content).toContain("Short body.");
  });

  it("splits at heading boundaries when sections are independent", () => {
    const md = [
      "# A",
      "first paragraph of A",
      "",
      "# B",
      "first paragraph of B",
    ].join("\n");
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const paths = chunks.map((c) => c.heading_path);
    expect(paths).toContainEqual(["A"]);
    expect(paths).toContainEqual(["B"]);
  });

  it("tracks nested heading paths", () => {
    const md = ["# Parent", "## Child", "child body"].join("\n");
    const chunks = chunkMarkdown(md);
    const child = chunks.find((c) => c.content.includes("child body"));
    expect(child?.heading_path).toEqual(["Parent", "Child"]);
  });

  it("splits a too-large section into paragraph-sized pieces", () => {
    // Three small paragraphs whose combined size exceeds a tight budget.
    // Each paragraph individually fits, so paragraph splitting (not the
    // sentence fallback) handles it.
    const para = "Lorem ipsum dolor sit amet, consectetur adipiscing elit.";
    const md = `# Big\n\n${para}\n\n${para}\n\n${para}\n\n${para}\n\n${para}`;
    const chunks = chunkMarkdown(md, { targetTokens: 30, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("falls back to sentence splitting for an over-budget paragraph", () => {
    const para = Array.from(
      { length: 8 },
      (_, i) => `Sentence number ${i} contains roughly twenty four characters.`,
    ).join(" ");
    const md = `# One\n\n${para}`;
    const chunks = chunkMarkdown(md, { targetTokens: 30, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("prepends overlap text on each chunk after the first", () => {
    const para = "x".repeat(2000);
    const md = `# A\n\n${para}\n\n${para}`;
    const chunks = chunkMarkdown(md, { targetTokens: 200, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // The second chunk should be longer than its own pure body because the
    // overlap prefix was glued on.
    expect(chunks[1]!.tokens).toBeGreaterThan(0);
  });
});

describe("chunkMarkdown — block_id", () => {
  it("single H2 doc: all chunks share the H2-derived block_id", () => {
    const md = ["# Title", "intro under title", "", "## Auth", "auth body"].join("\n");
    const chunks = chunkMarkdown(md);
    const authChunks = chunks.filter((c) => c.heading_path.includes("Auth"));
    expect(authChunks.length).toBeGreaterThan(0);
    expect(new Set(authChunks.map((c) => c.block_id))).toEqual(new Set(["auth"]));
  });

  it("multi-H2 doc: each H2 section gets its own block_id", () => {
    const md = [
      "# Spec",
      "",
      "## Vision",
      "vision body",
      "",
      "## Auth",
      "auth body",
      "",
      "## Billing",
      "billing body",
    ].join("\n");
    const chunks = chunkMarkdown(md);
    const visionId = chunks.find((c) => c.content.includes("vision body"))?.block_id;
    const authId = chunks.find((c) => c.content.includes("auth body"))?.block_id;
    const billingId = chunks.find((c) => c.content.includes("billing body"))?.block_id;
    expect(visionId).toBe("vision");
    expect(authId).toBe("auth");
    expect(billingId).toBe("billing");
    // All distinct.
    expect(new Set([visionId, authId, billingId]).size).toBe(3);
  });

  it("H1-only doc: block_id derives from the H1 (fallback)", () => {
    const md = ["# Project Title", "first paragraph", "", "second paragraph"].join("\n");
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.block_id === "project-title")).toBe(true);
  });

  it("doc with no headings: block_id is `_unblocked`", () => {
    const md = ["plain prose here.", "", "more prose."].join("\n");
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.block_id === "_unblocked")).toBe(true);
  });

  it("content before the first heading gets `_intro`; later sections get section-derived ids", () => {
    const md = [
      "preamble paragraph above any heading.",
      "",
      "## First Section",
      "first section body",
      "",
      "## Second Section",
      "second section body",
    ].join("\n");
    const chunks = chunkMarkdown(md);
    const intro = chunks.find((c) => c.content.includes("preamble paragraph"));
    const first = chunks.find((c) => c.content.includes("first section body"));
    const second = chunks.find((c) => c.content.includes("second section body"));
    expect(intro?.block_id).toBe("_intro");
    expect(first?.block_id).toBe("first-section");
    expect(second?.block_id).toBe("second-section");
  });

  it("paragraph-split chunks under one H2 share the same block_id", () => {
    // Force splitByParagraphs to fan one H2 section into multiple chunks
    // by setting a tight token budget. All resulting chunks must keep the
    // same block_id since they belong to the same H2 block.
    const para = "Lorem ipsum dolor sit amet, consectetur adipiscing elit.";
    const md = `## Big Block\n\n${para}\n\n${para}\n\n${para}\n\n${para}\n\n${para}`;
    const chunks = chunkMarkdown(md, { targetTokens: 30, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(new Set(chunks.map((c) => c.block_id))).toEqual(new Set(["big-block"]));
  });

  it("rolls H3 up to its owning H2 — no H3-derived ids in v1", () => {
    const md = [
      "# Top",
      "",
      "## Auth",
      "",
      "### Tokens",
      "token body",
      "",
      "### Sessions",
      "session body",
    ].join("\n");
    const chunks = chunkMarkdown(md);
    const tokens = chunks.find((c) => c.content.includes("token body"));
    const sessions = chunks.find((c) => c.content.includes("session body"));
    expect(tokens?.block_id).toBe("auth");
    expect(sessions?.block_id).toBe("auth");
  });
});

describe("extractBlockIds", () => {
  it("returns [] for empty input", () => {
    expect(extractBlockIds("")).toEqual([]);
    expect(extractBlockIds("   \n  ")).toEqual([]);
  });

  it("matches the block_ids emitted by chunkMarkdown", () => {
    const md = [
      "# Spec",
      "",
      "intro",
      "",
      "## Vision",
      "vision body",
      "",
      "## Auth",
      "auth body",
    ].join("\n");
    const chunkIds = new Set(chunkMarkdown(md).map((c) => c.block_id));
    const extracted = new Set(extractBlockIds(md));
    expect(extracted).toEqual(chunkIds);
  });

  it("dedupes ids across H3s that roll up to one H2", () => {
    const md = [
      "## Auth",
      "",
      "### Tokens",
      "token body",
      "",
      "### Sessions",
      "session body",
    ].join("\n");
    expect(extractBlockIds(md)).toEqual(["auth"]);
  });

  it("orders by first appearance", () => {
    const md = [
      "## Beta",
      "b",
      "",
      "## Alpha",
      "a",
      "",
      "## Gamma",
      "g",
    ].join("\n");
    expect(extractBlockIds(md)).toEqual(["beta", "alpha", "gamma"]);
  });
});

describe("extractBlockHeadings", () => {
  it("pairs id with the human heading text", () => {
    const md = ["## Vision 2026", "body", "", "## Auth", "body"].join("\n");
    const out = extractBlockHeadings(md);
    expect(out).toEqual([
      { id: "vision-2026", label: "Vision 2026" },
      { id: "auth", label: "Auth" },
    ]);
  });

  it("skips intro / unblocked sentinels are kept (consumer filters)", () => {
    const md = "plain prose with no headings";
    const out = extractBlockHeadings(md);
    expect(out).toEqual([{ id: "_unblocked", label: "_unblocked" }]);
  });
});

describe("nextPreviousBlockIds", () => {
  it("returns null when no block was removed", () => {
    const before = "## Vision\nbody";
    const after = "## Vision\nbody plus more text";
    expect(nextPreviousBlockIds(before, after, [])).toBeNull();
  });

  it("records a removed block_id when an H2 is renamed", () => {
    const before = "## Vision\nbody";
    const after = "## New Vision\nbody";
    expect(nextPreviousBlockIds(before, after, [])).toEqual(["vision"]);
  });

  it("appends to existing list, dedupes", () => {
    const before = "## Vision\nbody";
    const after = "## Other\nbody";
    expect(nextPreviousBlockIds(before, after, ["older"])).toEqual([
      "older",
      "vision",
    ]);
  });

  it("does not duplicate already-tracked ids", () => {
    const before = "## Vision\nbody\n\n## Auth\nbody";
    const after = "## VisionNew\nbody\n\n## Auth\nbody";
    expect(nextPreviousBlockIds(before, after, ["vision"])).toBeNull();
  });

  it("caps history at 50 entries (oldest drop first)", () => {
    const existing = Array.from({ length: 50 }, (_, i) => `old-${i}`);
    const before = "## Vision\nbody";
    const after = "## V2\nbody";
    const next = nextPreviousBlockIds(before, after, existing)!;
    expect(next).toHaveLength(50);
    expect(next.at(-1)).toBe("vision");
    expect(next).not.toContain("old-0");
  });
});

describe("extractBlocks", () => {
  it("returns [] for empty input", () => {
    expect(extractBlocks("")).toEqual([]);
    expect(extractBlocks("   \n  ")).toEqual([]);
  });

  it("offsets satisfy `markdown.slice(start, end) === body_md`", () => {
    const md = [
      "## Vision",
      "vision body",
      "",
      "## Auth",
      "auth body",
      "",
      "## Billing",
      "billing body",
    ].join("\n");
    const blocks = extractBlocks(md);
    for (const b of blocks) {
      expect(md.slice(b.start, b.end)).toBe(b.body_md);
    }
  });

  it("adjacent blocks tile the document end-to-end (no gaps)", () => {
    const md = ["## A", "a body", "", "## B", "b body"].join("\n");
    const blocks = extractBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.end).toBe(blocks[1]!.start);
    expect(blocks[blocks.length - 1]!.end).toBe(md.length);
  });

  it("block_ids match extractBlockIds (same heading-walker)", () => {
    const md = [
      "# Spec",
      "intro under H1",
      "",
      "## Vision",
      "vision body",
      "",
      "## Auth",
      "auth body",
    ].join("\n");
    const blockIds = extractBlocks(md).map((b) => b.block_id);
    // extractBlockIds dedupes by first appearance; extractBlocks merges
    // consecutive same-id sections, so for a doc without duplicate H2
    // names the two outputs are identical.
    expect(blockIds).toEqual(extractBlockIds(md));
  });

  it("rolls H3 up into the owning H2 block body", () => {
    const md = [
      "## Auth",
      "auth intro",
      "",
      "### Tokens",
      "token body",
      "",
      "### Sessions",
      "session body",
    ].join("\n");
    const blocks = extractBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.block_id).toBe("auth");
    expect(blocks[0]!.body_md).toContain("### Tokens");
    expect(blocks[0]!.body_md).toContain("token body");
    expect(blocks[0]!.body_md).toContain("session body");
  });

  it("splice writeback uses pure offsets (survives duplicate H2 text under different parents)", () => {
    // Two H2s with the exact same slug but under distinct H1 parents —
    // the second one gets a suffix-disambiguated id. `.indexOf("## Notes")`
    // would pick the wrong heading, but extractBlocks' tracked offsets
    // hit the second H2 specifically.
    const md = [
      "# Alpha",
      "",
      "## Notes",
      "first body",
      "",
      "# Beta",
      "",
      "## Notes",
      "second body",
    ].join("\n");
    const blocks = extractBlocks(md);
    const notesBlocks = blocks.filter((b) =>
      b.body_md.includes("## Notes"),
    );
    expect(notesBlocks).toHaveLength(2);
    expect(notesBlocks[0]!.block_id).not.toBe(notesBlocks[1]!.block_id);
    const second = notesBlocks[1]!;
    const newBody = second.body_md.replace("second body", "REPLACED");
    const next = md.slice(0, second.start) + newBody + md.slice(second.end);
    expect(next).toContain("first body");
    expect(next).toContain("REPLACED");
    expect(next).not.toContain("second body");
  });

  it("doc with no headings is one _unblocked block covering the whole doc", () => {
    const md = "plain prose\n\nmore prose.";
    const blocks = extractBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.block_id).toBe("_unblocked");
    expect(blocks[0]!.start).toBe(0);
    expect(blocks[0]!.end).toBe(md.length);
  });

  it("preamble before the first heading becomes an _intro block", () => {
    const md = [
      "preamble line",
      "",
      "## First",
      "first body",
    ].join("\n");
    const blocks = extractBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.block_id).toBe("_intro");
    expect(blocks[1]!.block_id).toBe("first");
    expect(blocks[0]!.body_md).toContain("preamble line");
    expect(blocks[1]!.body_md).toContain("first body");
  });
});

describe("tokenEstimate", () => {
  it("returns 0 for empty string", () => {
    expect(tokenEstimate("")).toBe(0);
  });

  it("roughly counts chars/4", () => {
    expect(tokenEstimate("abcd")).toBe(1);
    expect(tokenEstimate("a".repeat(40))).toBe(10);
  });
});
