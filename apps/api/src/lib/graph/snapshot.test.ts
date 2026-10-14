import { describe, expect, test } from "vitest";
import { buildGraphSnapshot } from "./snapshot";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";

const ISO = "2026-05-27T00:00:00.000Z";

function makeNode(overrides: Partial<KnowledgeNode>): KnowledgeNode {
  return {
    id: "node-base",
    workspace_id: "ws-1",
    parent_id: null,
    kind: "doc",
    slug: "node-base",
    title: "Base",
    content_md: "",
    data: {},
    tags: [],
    status: null,
    priority: null,
    assignee_id: null,
    due_date: null,
    position: 0,
    created_by: null,
    created_at: ISO,
    updated_at: ISO,
    ...overrides,
  };
}

const multiBlockMd = [
  "## Vision",
  "vision body",
  "",
  "## Pricing",
  "pricing body",
  "",
  "## Timeline",
  "timeline body",
].join("\n");

const monolithicMd = ["# Notes", "just a single body, no H2s anywhere."].join("\n");

describe("buildGraphSnapshot", () => {
  test("renders the workspace header and one line per node", () => {
    const nodes: KnowledgeNode[] = [
      makeNode({ id: "n-a", title: "Alpha", slug: "alpha" }),
      makeNode({ id: "n-b", title: "Beta", slug: "beta" }),
    ];
    const out = buildGraphSnapshot("Test workspace", nodes);
    expect(out).toContain("# Workspace graph: Test workspace");
    expect(out).toContain("/n/n-a");
    expect(out).toContain("/n/n-b");
    expect(out).toContain('"Alpha"');
    expect(out).toContain('"Beta"');
  });

  test("surfaces first-class tags without replacing kind", () => {
    const node = makeNode({
      id: "n-tagged",
      kind: "decision",
      tags: [
        {
          id: "tag-ai",
          workspace_id: "ws-1",
          name: "AI",
          normalized_name: "ai",
          slug: "ai",
          description: null,
          merged_into_id: null,
          deleted_at: null,
          created_at: ISO,
          updated_at: ISO,
        },
      ],
    });

    const out = buildGraphSnapshot("ws", [node]);

    expect(out).toContain("[decision]");
    expect(out).toContain("tags:[#ai]");
  });

  test("multi-H2 nodes get a `blocks:[#a, #b, …]` suffix", () => {
    const nodes: KnowledgeNode[] = [
      makeNode({
        id: "n-vision",
        title: "Vision 2026",
        slug: "vision-2026",
        content_md: multiBlockMd,
      }),
    ];
    const out = buildGraphSnapshot("ws", nodes);
    expect(out).toMatch(/blocks:\[#vision, #pricing, #timeline\]/);
  });

  test("single-block / no-H2 nodes skip the blocks suffix", () => {
    const nodes: KnowledgeNode[] = [
      makeNode({
        id: "n-mono",
        title: "Monolithic doc",
        slug: "monolithic-doc",
        content_md: monolithicMd,
      }),
    ];
    const out = buildGraphSnapshot("ws", nodes);
    const monoLine = out
      .split("\n")
      .find((line) => line.includes("/n/n-mono"));
    expect(monoLine).toBeDefined();
    expect(monoLine).not.toContain("blocks:");
  });

  test("non-active nodes cap blocks at 8 with a `+N more` suffix", () => {
    // Twelve H2 headings → 12 block ids. Snapshot shows the first 8
    // and `+4 more`.
    const md = Array.from({ length: 12 }, (_, i) => `## H${i}\nbody ${i}`).join(
      "\n\n",
    );
    const nodes: KnowledgeNode[] = [
      makeNode({
        id: "n-big",
        title: "Outline",
        slug: "outline",
        content_md: md,
      }),
    ];
    const out = buildGraphSnapshot("ws", nodes);
    const line = out.split("\n").find((l) => l.includes("/n/n-big"))!;
    expect(line).toContain("#h0");
    expect(line).toContain("#h7");
    expect(line).not.toContain("#h8");
    expect(line).toContain("+4 more");
  });

  test("active node bypasses the 8-block cap (full granularity)", () => {
    const md = Array.from({ length: 12 }, (_, i) => `## H${i}\nbody ${i}`).join(
      "\n\n",
    );
    const nodes: KnowledgeNode[] = [
      makeNode({
        id: "n-big",
        title: "Outline",
        slug: "outline",
        content_md: md,
      }),
    ];
    const out = buildGraphSnapshot("ws", nodes, { activeNodeId: "n-big" });
    const line = out.split("\n").find((l) => l.includes("/n/n-big"))!;
    expect(line).toContain("#h0");
    expect(line).toContain("#h11");
    expect(line).not.toContain("+");
  });

  test("active focus marker appears with an activeNodeId", () => {
    const nodes: KnowledgeNode[] = [
      makeNode({ id: "n-active", title: "Active", slug: "active" }),
      makeNode({ id: "n-other", title: "Other", slug: "other" }),
    ];
    const out = buildGraphSnapshot("ws", nodes, { activeNodeId: "n-active" });
    expect(out).toContain("ACTIVE");
    const activeLine = out
      .split("\n")
      .find((l) => l.includes("/n/n-active"))!;
    expect(activeLine).toContain("ACTIVE");
  });

  test("no active focus marker without an activeNodeId", () => {
    const nodes: KnowledgeNode[] = [
      makeNode({ id: "n-a", title: "Alpha", slug: "alpha" }),
    ];
    const out = buildGraphSnapshot("ws", nodes);
    expect(out).not.toContain("ACTIVE");
  });
});
