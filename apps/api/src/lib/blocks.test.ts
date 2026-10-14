/**
 * Block edits are offset splices: everything outside the target block is
 * byte-for-byte what it was, and a re-extract after the edit lands on the
 * same blocks. That property is what makes an unpinned MCP retry safe.
 */
import { describe, expect, it } from "vitest";
import { extractBlocks } from "@bcontext-dev/contract/rag/chunk";
import { appendBlock, listBlocks, replaceBlock } from "./blocks";

const DOC = [
  "Intro line before any heading.",
  "",
  "## Goal",
  "",
  "Ship it.",
  "",
  "## Notes",
  "",
  "- [ ] one",
  "- [x] two",
  "",
].join("\n");

describe("appendBlock", () => {
  it("adds a new H2 at the end and leaves the rest untouched", () => {
    const res = appendBlock(DOC, { heading: "Result", body_md: "Done in PR 1.\n" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.content_md.startsWith(DOC.trimEnd())).toBe(true);
    expect(res.content_md.endsWith("\n## Result\n\nDone in PR 1.\n")).toBe(true);
    expect(res.block).toEqual({ block_id: "result", heading: "Result", body_md: "Done in PR 1." });
    expect(listBlocks(res.content_md).map((b) => b.block_id)).toEqual(["_intro", "goal", "notes", "result"]);
  });

  it("works on an empty body and tolerates a `## ` prefix in the heading", () => {
    const res = appendBlock("", { heading: "## Plan", body_md: "" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.content_md).toBe("## Plan\n");
    expect(res.block.block_id).toBe("plan");
  });

  it("refuses a heading that already names a block and points at replace_block", () => {
    const res = appendBlock(DOC, { heading: "notes", body_md: "x" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/#notes/);
    expect(res.error).toMatch(/replace_block/);
    expect(res.blocks).toEqual(["_intro", "goal", "notes"]);
  });
});

describe("replaceBlock", () => {
  it("rewrites only the addressed block", () => {
    const res = replaceBlock(DOC, {}, { block_id: "goal", body_md: "Ship it twice." });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.content_md).toBe(DOC.replace("Ship it.", "Ship it twice."));
    expect(res.block).toEqual({ block_id: "goal", heading: "Goal", body_md: "Ship it twice." });
    expect(res.before).toEqual({ block_id: "goal", heading: "Goal", body_md: "Ship it." });
  });

  it("renames the block when a heading is given and keeps the splice contiguous", () => {
    const res = replaceBlock(DOC, {}, { block_id: "notes", body_md: "- [x] one\n- [x] two", heading: "Checklist" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.block.block_id).toBe("checklist");
    expect(listBlocks(res.content_md).map((b) => b.block_id)).toEqual(["_intro", "goal", "checklist"]);
    const blocks = extractBlocks(res.content_md);
    for (let i = 1; i < blocks.length; i++) expect(blocks[i]!.start).toBe(blocks[i - 1]!.end);
  });

  it("accepts a leading # in the block id and rewrites the intro without a heading", () => {
    const res = replaceBlock(DOC, {}, { block_id: "#_intro", body_md: "New intro." });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.content_md.startsWith("New intro.\n\n## Goal")).toBe(true);
    const renamed = replaceBlock(DOC, {}, { block_id: "_intro", body_md: "x", heading: "Intro" });
    expect(renamed.ok).toBe(false);
  });

  it("names the existing blocks when the id is unknown, and says so when it was renamed", () => {
    const missing = replaceBlock(DOC, {}, { block_id: "nope", body_md: "x" });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error).toMatch(/#_intro, #goal, #notes/);
    const renamed = replaceBlock(DOC, { previous_block_ids: ["old-notes"] }, { block_id: "old-notes", body_md: "x" });
    expect(renamed.ok).toBe(false);
    if (renamed.ok) return;
    expect(renamed.error).toMatch(/renamed/);
  });

  it("re-applies cleanly onto a body another writer changed elsewhere", () => {
    // Agent B rewrote #notes; agent A's edit to #goal must land unchanged.
    const byB = replaceBlock(DOC, {}, { block_id: "notes", body_md: "- [x] one\n- [x] two" });
    expect(byB.ok).toBe(true);
    if (!byB.ok) return;
    const byA = replaceBlock(byB.content_md, {}, { block_id: "goal", body_md: "Ship it twice." });
    expect(byA.ok).toBe(true);
    if (!byA.ok) return;
    expect(listBlocks(byA.content_md)).toEqual([
      { block_id: "_intro", heading: null, body_md: "Intro line before any heading." },
      { block_id: "goal", heading: "Goal", body_md: "Ship it twice." },
      { block_id: "notes", heading: "Notes", body_md: "- [x] one\n- [x] two" },
    ]);
  });
});
