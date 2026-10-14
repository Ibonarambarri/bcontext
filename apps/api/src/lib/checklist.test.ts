import { describe, expect, it } from "vitest";
import { listChecklistItems, toggleChecklistItem } from "./checklist";

const MD = [
  "Intro line",
  "- [ ] intro item",
  "",
  "## Plan",
  "",
  "- [ ] first",
  "- [x] second",
  "  - [ ] nested",
  "",
  "## Plan",
  "",
  "1. [ ] ordered",
  "",
  "## Done",
  "",
  "no items here",
].join("\n");

describe("listChecklistItems", () => {
  it("enumerates items in document order with block scoping", () => {
    const all = listChecklistItems(MD);
    expect(all.map((i) => i.text)).toEqual([
      "intro item",
      "first",
      "second",
      "nested",
      "ordered",
    ]);
    expect(all[0]!.block_id).toBe("_intro");
    expect(all[1]!.block_id).toBe("plan");
    // Duplicate heading gets the -2 suffix, matching the chunker.
    expect(all[4]!.block_id).toBe("plan-2");
  });

  it("re-indexes from 0 inside a block scope", () => {
    const scoped = listChecklistItems(MD, "plan");
    expect(scoped.map((i) => [i.index, i.text])).toEqual([
      [0, "first"],
      [1, "second"],
      [2, "nested"],
    ]);
  });

  it("uses _unblocked when the document has no headings", () => {
    const items = listChecklistItems("- [ ] solo");
    expect(items[0]!.block_id).toBe("_unblocked");
  });

  it("ignores checkbox-shaped lines inside fenced code blocks", () => {
    const md = [
      "## Tasks",
      "",
      "- [ ] real A",
      "- [ ] real B",
      "",
      "```",
      "- [ ] fake in fence 1",
      "- [ ] fake in fence 2",
      "```",
      "",
      "- [ ] real C",
      "",
      "~~~md",
      "- [x] fake in tilde fence",
      "~~~",
    ].join("\n");
    const items = listChecklistItems(md);
    expect(items.map((i) => i.text)).toEqual(["real A", "real B", "real C"]);
    // Index 2 must hit "real C", not mutate the fence.
    const res = toggleChecklistItem(md, { index: 2, checked: true });
    if (!res.ok) throw new Error(res.error);
    expect(res.item.text).toBe("real C");
    expect(res.content_md).toContain("- [ ] fake in fence 1");
    expect(res.content_md).toContain("- [x] real C");
  });
});

describe("toggleChecklistItem", () => {
  it("toggles when checked is omitted", () => {
    const res = toggleChecklistItem(MD, { index: 1 });
    if (!res.ok) throw new Error(res.error);
    expect(res.item.checked).toBe(true);
    expect(res.content_md).toContain("- [x] first");
    // Everything else untouched.
    expect(res.content_md).toContain("- [ ] intro item");
    expect(res.content_md).toContain("- [x] second");
  });

  it("sets an explicit state idempotently", () => {
    const res = toggleChecklistItem(MD, { index: 2, checked: true });
    if (!res.ok) throw new Error(res.error);
    expect(res.item.checked).toBe(true);
    expect(res.content_md).toBe(MD); // was already checked
  });

  it("scopes the index to a block and preserves indentation", () => {
    const res = toggleChecklistItem(MD, { index: 2, block_id: "plan" });
    if (!res.ok) throw new Error(res.error);
    expect(res.item.text).toBe("nested");
    expect(res.content_md).toContain("  - [x] nested");
  });

  it("returns the found items on a bad index", () => {
    const res = toggleChecklistItem(MD, { index: 9, block_id: "done" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.items).toEqual([]);
    expect(res.error).toContain('block "done"');
  });
});
