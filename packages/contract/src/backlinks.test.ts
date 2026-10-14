import { describe, expect, test } from "vitest";
import {
  findBacklinks,
  findForwardLinks,
  resolveBlockReference,
} from "./backlinks.js";

type N = {
  id: string;
  title: string;
  slug: string;
  kind: string;
  content_md: string;
};

const target: N = {
  id: "target-id",
  title: "Auth design",
  slug: "auth-design",
  kind: "doc",
  content_md: "",
};

function ref(id: string, content_md: string): N {
  return { id, title: `Node ${id}`, slug: id, kind: "doc", content_md };
}

describe("findBacklinks", () => {
  test("matches links by node id", () => {
    const out = findBacklinks(
      [target, ref("a", "See [auth](/w/ws/n/target-id) for details.")],
      target,
    );
    expect(out.map((b) => b.id)).toEqual(["a"]);
    expect(out[0]!.title).toBe("Node a");
  });

  test("matches links by slug", () => {
    const out = findBacklinks(
      [target, ref("b", "Related: [auth](/w/ws/s/auth-design)")],
      target,
    );
    expect(out.map((b) => b.id)).toEqual(["b"]);
  });

  test("excludes the target node itself", () => {
    const self = { ...target, content_md: "/n/target-id self-ref" };
    const out = findBacklinks([self, ref("c", "ref /n/target-id")], target);
    expect(out.map((b) => b.id)).toEqual(["c"]);
  });

  test("returns empty when no node references target", () => {
    const out = findBacklinks(
      [ref("x", "no link here"), ref("y", "/n/other-id")],
      target,
    );
    expect(out).toEqual([]);
  });

  test("snippet is the line containing the reference", () => {
    const out = findBacklinks(
      [
        ref(
          "d",
          "intro line\nLook at [Auth design](/w/ws/n/target-id) for context\ntail line",
        ),
      ],
      target,
    );
    expect(out[0]!.snippet).toContain("Auth design");
    expect(out[0]!.snippet).toContain("for context");
    expect(out[0]!.snippet).not.toContain("intro line");
    expect(out[0]!.snippet).not.toContain("tail line");
  });

  test("results are sorted alphabetically by title", () => {
    const out = findBacklinks(
      [
        { ...ref("z", "/n/target-id"), title: "Zeta" },
        { ...ref("m", "/n/target-id"), title: "Mu" },
        { ...ref("a", "/n/target-id"), title: "Alpha" },
      ],
      target,
    );
    expect(out.map((b) => b.title)).toEqual(["Alpha", "Mu", "Zeta"]);
  });

  test("does not false-match longer ids/slugs", () => {
    const out = findBacklinks(
      [
        ref("a", "see /n/target-id-other for related"),
        ref("b", "compare /s/auth-design-v2 instead"),
      ],
      target,
    );
    expect(out).toEqual([]);
  });

  test("matches when followed by markdown link close paren", () => {
    const out = findBacklinks(
      [ref("c", "see [the doc](/w/ws/n/target-id) here")],
      target,
    );
    expect(out.map((b) => b.id)).toEqual(["c"]);
  });
});

describe("block-level reference syntax", () => {
  test("node-level reference parses with block_id null", () => {
    const out = findBacklinks(
      [ref("a", "see /n/target-id for the rationale")],
      target,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.block_id).toBeNull();
  });

  test("/n/<id>#<block-id> captures the block_id", () => {
    const out = findBacklinks(
      [ref("a", "see /n/target-id#vision for the rationale")],
      target,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.block_id).toBe("vision");
  });

  test("/s/<slug>#<block-id> also captures", () => {
    const out = findBacklinks(
      [ref("b", "see /s/auth-design#tokens here")],
      target,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.block_id).toBe("tokens");
  });

  test("block_id captures full identifier — terminated by non-id char", () => {
    // The lookahead `(?![A-Za-z0-9_-])` ensures the match is greedy across
    // valid id characters and only stops at a real boundary. So
    // `/n/target-id#vision-2026extra ` captures `vision-2026extra` as a
    // single unit (not "vision-2026" + trailing "extra"). Whether that
    // block actually exists is a separate concern (`resolveBlockReference`).
    const out = findBacklinks(
      [ref("a", "see /n/target-id#vision-2026extra blah")],
      target,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.block_id).toBe("vision-2026extra");
  });

  test("/n/<id>#<block-id> followed by punctuation captures cleanly", () => {
    const out = findBacklinks(
      [ref("a", "compare /n/target-id#vision-2026 with the others.")],
      target,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.block_id).toBe("vision-2026");
  });

  test("the lookahead boundary stops block_id at non-id punctuation", () => {
    // `/n/target-id#vision)` — paren is outside the id alphabet so the
    // boundary check succeeds at `vision`; `block_id` is exactly `vision`.
    const out = findBacklinks(
      [ref("a", "see [auth](/w/ws/n/target-id#vision) for context")],
      target,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.block_id).toBe("vision");
  });

  test("findForwardLinks returns block_id on each result", () => {
    const t1 = {
      id: "t1",
      title: "T1",
      slug: "t1",
      kind: "doc",
      content_md: "",
    };
    const t2 = {
      id: "t2",
      title: "T2",
      slug: "t2",
      kind: "doc",
      content_md: "",
    };
    const source = {
      id: "src",
      title: "Source",
      slug: "src",
      kind: "doc",
      content_md: "see /n/t1#auth and /n/t2 for details",
    };
    const out = findForwardLinks([t1, t2, source], source);
    const byId = new Map(out.map((r) => [r.id, r]));
    expect(byId.get("t1")!.block_id).toBe("auth");
    expect(byId.get("t2")!.block_id).toBeNull();
  });

  test("explicit object mention preserves block_id", () => {
    const source = {
      id: "src",
      title: "Source",
      slug: "src",
      kind: "doc",
      content_md: "",
      data: {
        mentions: [{ id: "target-id", block_id: "vision" }],
      },
    };
    const t = {
      id: "target-id",
      title: "T",
      slug: "auth-design",
      kind: "doc",
      content_md: "",
    };
    const fwd = findForwardLinks([t, source], source);
    expect(fwd[0]!.block_id).toBe("vision");
    const back = findBacklinks([source], { id: "target-id", slug: "auth-design" });
    expect(back[0]!.block_id).toBe("vision");
  });

  test("legacy string mentions still work, block_id is null", () => {
    const source = {
      id: "src",
      title: "Source",
      slug: "src",
      kind: "doc",
      content_md: "",
      data: { mentions: ["target-id"] },
    };
    const back = findBacklinks([source], { id: "target-id", slug: "auth-design" });
    expect(back[0]!.block_id).toBeNull();
  });
});

describe("resolveBlockReference", () => {
  test("resolves a block present in current content_md", () => {
    const node = {
      content_md: "# Title\n\n## Vision\nbody\n\n## Auth\nbody",
      data: {},
    };
    expect(resolveBlockReference(node, "vision").found).toBe("current");
    expect(resolveBlockReference(node, "auth").found).toBe("current");
  });

  test("resolves a renamed block via previous_block_ids", () => {
    const node = {
      content_md: "## New Vision\nbody",
      data: { previous_block_ids: ["vision"] },
    };
    expect(resolveBlockReference(node, "vision").found).toBe("previous");
    expect(resolveBlockReference(node, "new-vision").found).toBe("current");
  });

  test("missing block_id returns missing", () => {
    const node = { content_md: "## Vision\nbody", data: {} };
    expect(resolveBlockReference(node, "nope").found).toBe("missing");
  });
});
