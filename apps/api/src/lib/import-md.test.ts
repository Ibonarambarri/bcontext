import { describe, expect, it } from "vitest";
import { directoryTagsForPath, parseMarkdown } from "./import-md";

describe("folderless Markdown import", () => {
  it("falls back to a title-cased filename", () => {
    const parsed = parseMarkdown("# body\n\ntext", "my-doc.md");
    expect(parsed).toMatchObject({ title: "My doc", kind: "doc" });
    expect(parsed.content_md).toBe("# body\n\ntext");
  });

  it("converts legacy category frontmatter into an accumulated tag", () => {
    const source = `---\ntitle: Pricing\nkind: decision\ncategory: business\nstatus: review\npriority: high\ntags: [pricing, q4]\n---\n\nThe content.`;
    const parsed = parseMarkdown(source, "ignored.md");
    expect(parsed).toMatchObject({
      title: "Pricing",
      kind: "decision",
      status: "review",
      priority: "high",
      tags: ["pricing", "q4", "business"],
      content_md: "The content.",
    });
    expect(parsed).not.toHaveProperty("category");
  });

  it("downgrades retired folder kind and ignores invalid enum values", () => {
    const source = `---\nkind: folder\ncategory: nonsense\nstatus: invented\npriority: ultra\ntags: [Foo, "foo", "BAR ", "", 1]\n---\n\nbody`;
    expect(parseMarkdown(source, "x.md")).toMatchObject({
      kind: "doc",
      status: null,
      priority: null,
      tags: ["foo", "bar"],
    });
  });

  it("accumulates all directory segments as normalized tags", () => {
    expect(directoryTagsForPath("Clients/Acme_Corp/Research/brief.md")).toEqual([
      "clients",
      "acme corp",
      "research",
    ]);
  });

  it("preserves malformed frontmatter as content", () => {
    const parsed = parseMarkdown("---\nthis is :: not yaml: [unclosed\n\n# heading", "broken.md");
    expect(parsed.content_md.length).toBeGreaterThan(0);
  });
});
