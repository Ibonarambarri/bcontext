import { describe, expect, it } from "vitest";
import { applySegmentEdits, segmentMarkdown } from "./autofix";

describe("segmentMarkdown", () => {
  it("splits on H2 boundaries with a preamble", () => {
    const { frontmatter, segments } = segmentMarkdown(
      "intro line\n\n## One\na\n\n## Two\nb",
    );
    expect(frontmatter).toBe("");
    expect(segments).toEqual(["intro line\n", "## One\na\n", "## Two\nb"]);
  });

  it("peels frontmatter off and never segments inside it", () => {
    const { frontmatter, segments } = segmentMarkdown(
      "---\ntitle: x\n---\n## A\nbody",
    );
    expect(frontmatter).toBe("---\ntitle: x\n---\n");
    expect(segments).toEqual(["## A\nbody"]);
  });

  it("ignores ## inside code fences", () => {
    const { segments } = segmentMarkdown(
      "## A\n```\n## not a heading\n```\n\n## B\nx",
    );
    expect(segments).toHaveLength(2);
    expect(segments[0]).toContain("## not a heading");
  });

  it("treats a heading-less wall of text as one segment", () => {
    const { segments } = segmentMarkdown("just\nplain\ntext");
    expect(segments).toEqual(["just\nplain\ntext"]);
  });
});

describe("applySegmentEdits", () => {
  const md = "---\nk: v\n---\nintro\n\n## One\na\n\n## Two\nb";

  it("reassembles identically with no edits", () => {
    const { frontmatter, segments } = segmentMarkdown(md);
    expect(applySegmentEdits(frontmatter, segments, [])).toBe(md);
  });

  it("replaces only the edited segment", () => {
    const { frontmatter, segments } = segmentMarkdown(md);
    const out = applySegmentEdits(frontmatter, segments, [
      { index: 1, markdown: "## One\n- a\n" },
    ]);
    expect(out).toContain("## One\n- a");
    expect(out).toContain("## Two\nb");
    expect(out.startsWith("---\nk: v\n---\nintro")).toBe(true);
  });

  it("drops out-of-range edit indexes", () => {
    const { frontmatter, segments } = segmentMarkdown(md);
    expect(
      applySegmentEdits(frontmatter, segments, [{ index: 99, markdown: "x" }]),
    ).toBe(md);
  });
});
