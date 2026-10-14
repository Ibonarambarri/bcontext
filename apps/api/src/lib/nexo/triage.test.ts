import { afterEach, describe, expect, it, vi } from "vitest";

const detectContradiction = vi.fn();
const openConflict = vi.fn(async (input: { kind: string }) => ({ id: `conf-${input.kind}`, ...input }));
const acceptCandidate = vi.fn(async (_s: unknown, id: string) => ({ id, created_node_id: "node-1", status: "accepted" }));

vi.mock("./conflicts", () => ({
  detectContradiction: (...a: unknown[]) => detectContradiction(...(a as [])),
  openConflict: (...a: unknown[]) => openConflict(...(a as [{ kind: string }])),
}));
vi.mock("@/lib/ingest/candidates", () => ({
  acceptCandidate: (...a: unknown[]) => acceptCandidate(...(a as [unknown, string])),
}));
vi.mock("@/lib/storage", () => ({ getStorageById: async () => ({ workspace: { id: "ws-1" } }) }));
vi.mock("@/lib/auth/grants", () => ({ systemGrant: () => ({}) }));
vi.mock("@/lib/storage/scoped", () => ({ scopedStorage: (s: unknown) => s }));

import { autoAcceptThreshold, triageCandidate } from "./triage";

const candidate = (confidence: number) =>
  ({
    id: "cand-1",
    workspace_id: "ws-1",
    source: "jira",
    external_id: "x",
    kind: "decision" as const,
    title: "Use Postgres",
    content_md: "## Decision\nPostgres.",
    links: [],
    confidence,
    status: "pending" as const,
    provenance: {},
    created_node_id: null,
    reviewed_by: null,
    reviewed_at: null,
    reprocess_feedback: null,
    created_at: "2026-09-08T00:00:00Z",
  });

afterEach(() => {
  detectContradiction.mockReset();
  openConflict.mockClear();
  acceptCandidate.mockClear();
});

describe("NEXO triage", () => {
  it("reads the threshold from env with a sane default", () => {
    expect(autoAcceptThreshold({})).toBe(0.7);
    expect(autoAcceptThreshold({ NEXO_AUTO_ACCEPT_THRESHOLD: "0.9" })).toBe(0.9);
    expect(autoAcceptThreshold({ NEXO_AUTO_ACCEPT_THRESHOLD: "nope" })).toBe(0.7);
  });

  it("opens a contradiction conflict and leaves the candidate pending", async () => {
    detectContradiction.mockResolvedValue({
      contradiction: true,
      summary: "Candidate says Postgres, node says MySQL",
      contextMd: "…",
      evidence: [],
      relatedNodeIds: ["n1"],
    });
    const out = await triageCandidate(candidate(0.95));
    expect(out).toEqual({ kind: "conflict", conflictKind: "contradiction", conflictId: "conf-contradiction" });
    expect(acceptCandidate).not.toHaveBeenCalled();
    expect(openConflict).toHaveBeenCalledWith(expect.objectContaining({ kind: "contradiction", candidateId: "cand-1", relatedNodeIds: ["n1"] }));
  });

  it("auto-accepts above the threshold", async () => {
    detectContradiction.mockResolvedValue(null);
    const out = await triageCandidate(candidate(0.8));
    expect(out).toEqual({ kind: "accepted", nodeId: "node-1" });
    expect(openConflict).not.toHaveBeenCalled();
  });

  it("opens a doubt below the threshold", async () => {
    detectContradiction.mockResolvedValue(null);
    const out = await triageCandidate(candidate(0.4));
    expect(out).toEqual({ kind: "conflict", conflictKind: "doubt", conflictId: "conf-doubt" });
    expect(openConflict).toHaveBeenCalledWith(expect.objectContaining({ kind: "doubt", candidateId: "cand-1" }));
  });

  it("survives a detection failure and still decides on confidence", async () => {
    detectContradiction.mockRejectedValue(new Error("rag down"));
    const out = await triageCandidate(candidate(0.9));
    expect(out.kind).toBe("accepted");
  });

  it("does nothing for non-pending candidates", async () => {
    const out = await triageCandidate({ ...candidate(0.9), status: "accepted" });
    expect(out).toEqual({ kind: "pending", reason: "status_accepted" });
  });
});
