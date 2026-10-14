import { describe, expect, test } from "vitest";
import {
  buildBlockMentionCandidates,
  buildMentionCandidates,
  cleanSnippet,
  searchBlockMentions,
  searchMentions,
  type MentionCandidate,
} from "@bcontext-dev/contract/mention-search";

function n(
  id: string,
  title: string,
  slug = id,
  kind = "doc",
  content_md = "",
) {
  return { id, title, slug, kind, content_md };
}

const nodes = [
  n("a", "API design notes", "api-design-notes", "doc", "REST endpoints and auth flow."),
  n("b", "API gateway tradeoffs", "api-gateway-tradeoffs", "decision"),
  n("c", "Onboarding flow", "onboarding-flow", "doc"),
  n("d", "Q3 roadmap", "q3-roadmap", "task", "Quarterly plan."),
  n("e", "user-research transcript", "user-research-transcript", "meeting"),
];

describe("buildMentionCandidates", () => {
  test("maps nodes to candidates and excludes current", () => {
    const cands = buildMentionCandidates(nodes, "a");
    expect(cands).toHaveLength(nodes.length - 1);
    expect(cands.find((c) => c.id === "a")).toBeUndefined();
    expect(cands[0]).toMatchObject({
      id: "b",
      title: "API gateway tradeoffs",
      kind: "decision",
    });
  });

  test("snippet pulls from content_md", () => {
    const [cand] = buildMentionCandidates([nodes[3]!]);
    expect(cand!.snippet).toBe("Quarterly plan.");
  });

  test("works with nodes missing content_md", () => {
    const [cand] = buildMentionCandidates([
      { id: "x", title: "T", slug: "t", kind: "doc" },
    ]);
    expect(cand!.snippet).toBe("");
  });
});

describe("searchMentions", () => {
  const candidates: MentionCandidate[] = buildMentionCandidates(nodes);

  test("empty query returns all (capped by limit)", () => {
    expect(searchMentions("", candidates)).toHaveLength(5);
    expect(searchMentions("   ", candidates, 2)).toHaveLength(2);
  });

  test("title prefix wins over contains", () => {
    const results = searchMentions("api", candidates);
    expect(results[0]!.id).toBe("a"); // API design (prefix, shorter title)
    expect(results.map((r) => r.id)).toContain("b");
  });

  test("token prefix matches mid-title words", () => {
    const results = searchMentions("road", candidates);
    expect(results[0]!.title).toBe("Q3 roadmap");
  });

  test("slug fallback when title misses", () => {
    const results = searchMentions("transcript", candidates);
    expect(results[0]!.title).toBe("user-research transcript");
  });

  test("no match returns empty", () => {
    expect(searchMentions("nope-xyz", candidates)).toEqual([]);
  });

  test("case-insensitive", () => {
    expect(searchMentions("API", candidates)).toHaveLength(2);
    expect(searchMentions("api", candidates)).toHaveLength(2);
  });

  test("respects limit", () => {
    expect(searchMentions("", candidates, 3)).toHaveLength(3);
  });
});

describe("block-level mention autocomplete", () => {
  const md = [
    "# Project Spec",
    "",
    "## Vision",
    "the vision body",
    "",
    "## Auth",
    "auth body",
    "",
    "## Billing",
    "billing body",
  ].join("\n");
  const blockNodes = [
    {
      id: "n1",
      title: "Project Spec",
      slug: "project-spec",
      kind: "doc",
      content_md: md,
    },
    {
      id: "n2",
      title: "Random",
      slug: "random",
      kind: "doc",
      content_md: "## Notes\nbody",
    },
  ];

  test("buildBlockMentionCandidates yields one entry per block across nodes", () => {
    const cands = buildBlockMentionCandidates(blockNodes);
    const ids = cands.map((c) => `${c.node_id}:${c.block_id}`);
    // H1 ("Project Spec") and each H2 in n1, plus the single H2 in n2.
    expect(ids).toEqual([
      "n1:project-spec",
      "n1:vision",
      "n1:auth",
      "n1:billing",
      "n2:notes",
    ]);
    // Label format is "Node title › Block heading".
    const vision = cands.find((c) => c.block_id === "vision")!;
    expect(vision.label).toBe("Project Spec › Vision");
  });

  test("buildBlockMentionCandidates excludes _intro / _unblocked sentinels", () => {
    const cands = buildBlockMentionCandidates([
      {
        id: "x",
        title: "X",
        slug: "x",
        kind: "doc",
        content_md: "plain prose, no headings",
      },
    ]);
    expect(cands).toEqual([]);
  });

  test("buildBlockMentionCandidates honours excludeId", () => {
    const cands = buildBlockMentionCandidates(blockNodes, "n1");
    expect(cands.every((c) => c.node_id !== "n1")).toBe(true);
  });

  test("searchBlockMentions ranks by label prefix", () => {
    const cands = buildBlockMentionCandidates(blockNodes);
    const out = searchBlockMentions("auth", cands);
    expect(out[0]!.block_id).toBe("auth");
  });

  test("searchBlockMentions falls back to block_id match", () => {
    const cands = buildBlockMentionCandidates(blockNodes);
    const out = searchBlockMentions("billing", cands);
    expect(out[0]!.block_id).toBe("billing");
  });

  test("empty query returns all candidates capped by limit", () => {
    const cands = buildBlockMentionCandidates(blockNodes);
    expect(searchBlockMentions("", cands, 2)).toHaveLength(2);
  });
});

describe("cleanSnippet", () => {
  test("strips markdown noise and clamps to 80 chars", () => {
    const md =
      "# Heading\n\nSome **bold** and `inline code` plus [a link](http://x) and a list:\n- item one\n- item two";
    const out = cleanSnippet(md);
    expect(out).not.toContain("#");
    expect(out).not.toContain("**");
    expect(out).not.toContain("`");
    expect(out).not.toContain("](");
    expect(out).toContain("a link");
    expect(out.length).toBeLessThanOrEqual(80);
  });

  test("removes fenced code blocks entirely", () => {
    const out = cleanSnippet("intro\n```ts\nconst x = 1;\n```\nafter");
    expect(out).not.toContain("const x");
    expect(out).toContain("intro");
    expect(out).toContain("after");
  });

  test("collapses whitespace", () => {
    expect(cleanSnippet("a   b\n\n\nc")).toBe("a b c");
  });
});
