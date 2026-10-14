import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/queue/producers", () => ({ enqueue: vi.fn(async () => "job-1") }));

import { enqueue } from "@/lib/queue/producers";
import {
  enqueueContradictionScan,
  judgedPairKeys,
  maxPairsPerDay,
  pairKey,
  runContradictionScan,
  scanBlocks,
  selectPairs,
  type CandidatePair,
  type ContradictionDeps,
  type Neighbour,
  type ScanNode,
} from "./contradictions";

const NOW = new Date("2026-09-08T12:00:00.000Z");
const doc: ScanNode = {
  id: "doc-a",
  workspace_id: "ws",
  kind: "decision",
  title: "Pricing",
  content_md: [
    "## Decision",
    "We charge 29 euros per seat per month, billed yearly, for every workspace on the team plan.",
    "## Notes",
    "short",
  ].join("\n"),
  updated_at: "2026-09-08T11:00:00.000Z",
};

function hit(node_id: string, block_id: string, similarity = 0.8, extra: Partial<Neighbour> = {}): Neighbour {
  return { node_id, block_id, title: `Node ${node_id}`, kind: "doc", content: `text of ${node_id}#${block_id}`, similarity, ...extra };
}

function fakeDeps(overrides: Partial<ContradictionDeps> & { verdicts?: Record<string, boolean> } = {}) {
  const opened: Array<Parameters<ContradictionDeps["openConflict"]>[0]> = [];
  const judged: string[] = [];
  const deps: ContradictionDeps = {
    neighbours: async () => [],
    judge: async (_ws, pair: CandidatePair) => {
      judged.push(pairKey(pair.a, pair.b));
      const contradiction = overrides.verdicts?.[pair.b.node_id] ?? false;
      return {
        contradiction,
        summary: `${pair.a.title} says X, but ${pair.b.title} says Y.`,
        contextMd: "## A\nX\n\n## B\nY",
        excerptA: "X",
        excerptB: "Y",
      };
    },
    listEdges: async () => [],
    priorConflicts: async () => [],
    openConflict: async (input) => {
      opened.push(input);
      return { id: `c-${opened.length}` };
    },
    usedToday: async () => 0,
    ...overrides,
  };
  return { deps, opened, judged };
}

describe("scanBlocks", () => {
  it("yields H2 blocks with the heading dropped and skips short ones", () => {
    const blocks = scanBlocks(doc);
    expect(blocks.map((b) => b.block_id)).toEqual(["decision"]);
    expect(blocks[0]!.text).toMatch(/^We charge 29 euros/);
  });
});

describe("selectPairs", () => {
  const blocks = scanBlocks(doc);

  it("keeps the closest blocks of other doc/decision/adr nodes, best first", () => {
    const neighboursOf = new Map([[
      "decision",
      [hit("doc-b", "pricing", 0.6), hit("doc-c", "plans", 0.9), hit("doc-a", "decision", 0.99), hit("task-1", "x", 0.95, { kind: "task" }), hit("doc-d", "old", 0.3)],
    ]]);
    const pairs = selectPairs({ node: doc, blocks, neighboursOf, edges: [], prior: [] });
    expect(pairs.map((p) => `${p.b.node_id}#${p.b.block_id}`)).toEqual(["doc-c#plans", "doc-b#pricing"]);
  });

  it("skips pairs resolved by a supersedes edge in either direction, and superseded hits", () => {
    const neighboursOf = new Map([["decision", [hit("doc-b", "p"), hit("doc-c", "p"), hit("doc-d", "p", 0.9, { superseded_by: "doc-z" })]]]);
    const pairs = selectPairs({
      node: doc,
      blocks,
      neighboursOf,
      edges: [
        { from_node: "doc-a", to_node: "doc-b", relation: "supersedes" },
        { from_node: "doc-c", to_node: "doc-a", relation: "supersedes" },
      ],
      prior: [],
    });
    expect(pairs).toEqual([]);
  });

  it("does not re-ask about a pair already judged for this version of the node", () => {
    const neighboursOf = new Map([["decision", [hit("doc-b", "p"), hit("doc-c", "p")]]]);
    const prior = [
      // Open: still on the desk, whatever the text says now.
      { status: "open", created_at: "2026-09-01T00:00:00.000Z", urls: ["/n/doc-b#p", "/n/doc-a#decision"] },
      // Dismissed before the node's last edit: worth a second look.
      { status: "dismissed", created_at: "2026-09-01T00:00:00.000Z", urls: ["/n/doc-a#decision", "/n/doc-c#p"] },
    ];
    const pairs = selectPairs({ node: doc, blocks, neighboursOf, edges: [], prior });
    expect(pairs.map((p) => p.b.node_id)).toEqual(["doc-c"]);
    // Dismissed after the edit: settled.
    expect(judgedPairKeys([{ ...prior[1]!, created_at: "2026-09-08T11:30:00.000Z" }], doc.updated_at).size).toBe(1);
  });

  it("dedupes the same neighbour block reached from two changed blocks", () => {
    const two: ScanNode = { ...doc, content_md: `${doc.content_md}\n## Also\nAnother long enough paragraph about the very same pricing decision here.` };
    const b = scanBlocks(two);
    expect(b).toHaveLength(2);
    const neighboursOf = new Map(b.map((block) => [block.block_id, [hit("doc-b", "p")]]));
    expect(selectPairs({ node: two, blocks: b, neighboursOf, edges: [], prior: [] })).toHaveLength(2);
    // Same pair listed twice under one block collapses.
    const dup = new Map([["decision", [hit("doc-b", "p"), hit("doc-b", "p", 0.7)]]]);
    expect(selectPairs({ node: doc, blocks, neighboursOf: dup, edges: [], prior: [] })).toHaveLength(1);
  });
});

describe("runContradictionScan", () => {
  it("opens a conflict with citations to both blocks when the model says contradiction", async () => {
    const { deps, opened, judged } = fakeDeps({
      neighbours: async () => [hit("doc-b", "pricing", 0.9), hit("doc-c", "plans", 0.7)],
      verdicts: { "doc-b": true },
    });
    const result = await runContradictionScan({ nodeId: "doc-a", now: NOW, deps, loadNodes: async () => [doc] });
    expect(result).toMatchObject({ nodes: 1, blocks: 1, candidates: 2, judged: 2, opened: 1, capped: 0, workspaces: 1 });
    expect(judged).toEqual([pairKey({ node_id: "doc-a", block_id: "decision" }, { node_id: "doc-b", block_id: "pricing" }), expect.any(String)]);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      workspaceId: "ws",
      kind: "contradiction",
      relatedNodeIds: ["doc-a", "doc-b"],
      evidence: [
        { source: "graph", url: "/n/doc-a#decision", excerpt: "X" },
        { source: "graph", url: "/n/doc-b#pricing", excerpt: "Y" },
      ],
    });
  });

  it("stops asking the model once the workspace's daily cap is spent", async () => {
    const { deps, judged } = fakeDeps({
      neighbours: async () => [hit("doc-b", "p", 0.9), hit("doc-c", "p", 0.8), hit("doc-d", "p", 0.7)],
      usedToday: async () => 48,
    });
    const result = await runContradictionScan({ nodeId: "doc-a", now: NOW, deps, maxPairs: 50, loadNodes: async () => [doc] });
    expect(result).toMatchObject({ candidates: 3, judged: 2, capped: 1, opened: 0 });
    expect(judged).toHaveLength(2);
  });

  it("scans only the contradiction kinds and groups nodes per workspace", async () => {
    const other: ScanNode = { ...doc, id: "doc-b", workspace_id: "ws-2", kind: "doc" };
    const task: ScanNode = { ...doc, id: "task-1", kind: "task" };
    const { deps } = fakeDeps({ neighbours: async () => [hit("doc-x", "p")] });
    const result = await runContradictionScan({ now: NOW, deps, loadNodes: async () => [doc, other, task] });
    expect(result).toMatchObject({ nodes: 2, workspaces: 2, judged: 2, opened: 0 });
  });

  it("survives a retrieval failure on one block and judges the rest", async () => {
    const { deps } = fakeDeps({
      neighbours: async (_ws, block) => {
        if (block.block_id === "decision") throw new Error("embedding down");
        return [hit("doc-b", "p")];
      },
    });
    const two: ScanNode = { ...doc, content_md: `${doc.content_md}\n## Also\nAnother long enough paragraph about the very same pricing decision here.` };
    const result = await runContradictionScan({ nodeId: "doc-a", now: NOW, deps, loadNodes: async () => [two] });
    expect(result).toMatchObject({ blocks: 2, judged: 1 });
  });
});

describe("configuration and enqueue", () => {
  it("reads the daily cap from the environment with a default of 50", () => {
    expect(maxPairsPerDay({})).toBe(50);
    expect(maxPairsPerDay({ NEXO_CONTRADICTIONS_MAX_PAIRS: "5" })).toBe(5);
    expect(maxPairsPerDay({ NEXO_CONTRADICTIONS_MAX_PAIRS: "0" })).toBe(0);
    expect(maxPairsPerDay({ NEXO_CONTRADICTIONS_MAX_PAIRS: "nope" })).toBe(50);
  });

  it("enqueues one delayed singleton job per node", async () => {
    await enqueueContradictionScan({ workspaceId: "ws", nodeId: "doc-a" });
    expect(enqueue).toHaveBeenCalledWith(
      "nexo.contradictions",
      { workspace_id: "ws", node_id: "doc-a" },
      { singletonKey: "node:doc-a", startAfter: 120 },
    );
  });
});
