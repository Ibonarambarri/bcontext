/**
 * applyPlan writes into existing nodes only by block, and can record
 * "A supersedes B" between two graph nodes when there is no candidate.
 *
 * The first resolver asked the model for a node's "full new body" after
 * showing it only the first 3000 characters, and wrote the answer back:
 * six long nodes lost everything past that cut. These tests pin the two
 * properties that stop it happening again — a resolution never shortens a
 * node beyond the block it names, and a graph contradiction leaves an edge.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => ({}) }));
vi.mock("@/lib/ingest/candidates", () => ({
  acceptCandidate: vi.fn(),
  dismissCandidate: vi.fn(),
  getCandidate: vi.fn(),
}));

import { applyPlan, type NexoConflict } from "./conflicts";
import type { Storage } from "@/lib/storage";

const LONG_TAIL = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} that must survive the resolution.`).join("\n\n");

function fakeStorage(nodes: Record<string, { title: string; content_md: string }>) {
  const edges: Array<{ from_node: string; to_node: string; relation: string }> = [];
  const storage = {
    workspace: { id: "ws-1" },
    getNode: async (id: string) =>
      nodes[id] ? { id, kind: "decision", title: nodes[id].title, content_md: nodes[id].content_md, data: {} } : null,
    updateNode: async (id: string, patch: { content_md?: string }) => {
      if (patch.content_md !== undefined) nodes[id]!.content_md = patch.content_md;
      return { id, ...nodes[id] };
    },
    createEdge: async (edge: { from_node: string; to_node: string; relation: string }) => {
      edges.push(edge);
      return edge;
    },
    createNode: vi.fn(),
  };
  return { storage: storage as unknown as Storage, edges, nodes };
}

const conflict = (related: string[]): NexoConflict => ({
  id: "conf-1",
  workspace_id: "ws-1",
  kind: "contradiction",
  summary: "A vs B",
  context_md: "",
  evidence: [],
  related_node_ids: related,
  candidate_id: null,
  status: "open",
  decision_text: null,
  resolution: null,
  resolved_by: null,
  resolved_at: null,
  created_at: "2026-09-11T00:00:00Z",
});

describe("applyPlan — block edits", () => {
  it("update_block rewrites one block and leaves the rest of the node intact", async () => {
    const { storage, nodes } = fakeStorage({
      a: { title: "A", content_md: `## Context\n\nOld context.\n\n## Decision\n\nThe old rule.\n\n## Consequences\n\n${LONG_TAIL}` },
    });
    const result = await applyPlan(
      storage,
      conflict(["a"]),
      null,
      { summary: "s", actions: [{ op: "update_block", node_id: "a", block_id: "decision", content_md: "The new rule." }] },
      null,
    );
    expect(result.actions[0]?.note).toBeUndefined();
    expect(nodes.a!.content_md).toContain("## Decision\n\nThe new rule.");
    expect(nodes.a!.content_md).toContain("Old context.");
    expect(nodes.a!.content_md).toContain("Paragraph 39 that must survive");
  });

  it("append_block adds a note without touching existing blocks", async () => {
    const before = `## Decision\n\nKeep.\n\n## Consequences\n\n${LONG_TAIL}`;
    const { storage, nodes } = fakeStorage({ a: { title: "A", content_md: before } });
    await applyPlan(
      storage,
      conflict(["a"]),
      null,
      { summary: "s", actions: [{ op: "append_block", node_id: "a", heading: "Nota (2026-09-11)", content_md: "Clarified." }] },
      null,
    );
    expect(nodes.a!.content_md.startsWith(before)).toBe(true);
    expect(nodes.a!.content_md).toContain("## Nota (2026-09-11)\n\nClarified.");
  });

  it("refuses to rewrite a block the prompt only stubbed", async () => {
    const huge = "x".repeat(7000);
    const { storage, nodes } = fakeStorage({ a: { title: "A", content_md: `## Body\n\n${huge}` } });
    const result = await applyPlan(
      storage,
      conflict(["a"]),
      null,
      { summary: "s", actions: [{ op: "update_block", node_id: "a", block_id: "body", content_md: "short" }] },
      null,
    );
    expect(result.actions[0]?.note).toMatch(/too long/);
    expect(nodes.a!.content_md).toContain(huge);
  });

  it("reports an unknown block instead of guessing", async () => {
    const { storage, nodes } = fakeStorage({ a: { title: "A", content_md: "## Decision\n\nKeep." } });
    const result = await applyPlan(
      storage,
      conflict(["a"]),
      null,
      { summary: "s", actions: [{ op: "update_block", node_id: "a", block_id: "nope", content_md: "x" }] },
      null,
    );
    expect(result.actions[0]?.note).toMatch(/block not found/);
    expect(nodes.a!.content_md).toBe("## Decision\n\nKeep.");
  });
});

describe("applyPlan — supersede between graph nodes", () => {
  it("links the winner over the loser and appends a note to the loser", async () => {
    const { storage, edges, nodes } = fakeStorage({
      old: { title: "Manual onboarding", content_md: "## Decision\n\nBy hand." },
      new: { title: "Organization request", content_md: "## Decision\n\nBy request." },
    });
    const result = await applyPlan(
      storage,
      conflict(["new", "old"]),
      null,
      { summary: "s", actions: [{ op: "supersede_node", node_id: "old", superseded_by: "new", note: "Creation is by request now." }] },
      null,
    );
    expect(edges).toEqual([{ from_node: "new", to_node: "old", relation: "supersedes" }]);
    expect(nodes.old!.content_md).toContain("## Superseded (");
    expect(nodes.old!.content_md).toContain("Creation is by request now. See [Organization request](/n/new).");
    expect(nodes.new!.content_md).toBe("## Decision\n\nBy request.");
    expect(result.actions[0]).toMatchObject({ op: "supersede_node", node_id: "old", note: "superseded by Organization request" });
  });

  it("refuses a node outside the conflict", async () => {
    const { storage, edges } = fakeStorage({
      old: { title: "Old", content_md: "## Decision\n\nx" },
      other: { title: "Other", content_md: "## Decision\n\ny" },
    });
    const result = await applyPlan(
      storage,
      conflict(["old"]),
      null,
      { summary: "s", actions: [{ op: "supersede_node", node_id: "old", superseded_by: "other" }] },
      null,
    );
    expect(edges).toEqual([]);
    expect(result.actions[0]?.note).toMatch(/related to the conflict/);
  });
});
