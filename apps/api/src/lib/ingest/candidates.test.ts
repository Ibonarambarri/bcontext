import { afterEach, describe, expect, it, vi } from "vitest";

// In-memory fake `ingest_candidates` table + a minimal chainable Supabase
// query builder — enough to exercise propose/list/accept/dismiss without a
// real DB. Filters accumulate as `.eq()` calls; `maybeSingle`/`single`
// resolve against whatever filters were applied.
let table: Record<string, unknown>[] = [];
let nextId = 1;

function matches(row: Record<string, unknown>, filters: [string, unknown][]): boolean {
  return filters.every(([k, v]) => row[k] === v);
}

function makeAdmin() {
  return {
    from: (name: string) => {
      if (name !== "ingest_candidates") throw new Error(`unexpected table ${name}`);
      const filters: [string, unknown][] = [];
      let orderBy: string | null = null;
      const builder = {
        select: () => builder,
        eq: (k: string, v: unknown) => {
          filters.push([k, v]);
          return builder;
        },
        order: (k: string) => {
          orderBy = k;
          return builder;
        },
        maybeSingle: async () => {
          const row = table.find((r) => matches(r, filters)) ?? null;
          return { data: row, error: null };
        },
        insert: (payload: Record<string, unknown>) => {
          const row = { id: `cand-${nextId++}`, created_at: new Date(0).toISOString(), ...payload };
          table.push(row);
          return {
            select: () => ({
              single: async () => ({ data: row, error: null }),
            }),
          };
        },
        update: (patch: Record<string, unknown>) => ({
          eq: (k: string, v: unknown) => ({
            select: () => ({
              single: async () => {
                const row = table.find((r) => r[k] === v);
                if (!row) return { data: null, error: { message: "not found" } };
                Object.assign(row, patch);
                return { data: row, error: null };
              },
            }),
          }),
        }),
        then: async (resolve: (r: { data: unknown[]; error: null }) => void) => {
          let rows = table.filter((r) => matches(r, filters));
          if (orderBy) {
            rows = [...rows].sort((a, b) =>
              String(b[orderBy as string]).localeCompare(String(a[orderBy as string])),
            );
          }
          resolve({ data: rows, error: null });
        },
      };
      return builder;
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => makeAdmin(),
}));

const createdNodes: Record<string, unknown>[] = [];
const createdEdges: Record<string, unknown>[] = [];
let fakeStorage: unknown = {
  // The workspace the caller was authorised for. These functions now take it
  // from the storage rather than from the candidate row, which is what stops a
  // candidate from another tenant being accepted into it.
  backend: "supabase",
  workspace: { id: "ws-1", slug: "ws" },
  createNode: async (input: Record<string, unknown>) => {
    const node = { id: `node-${createdNodes.length + 1}`, ...input };
    createdNodes.push(node);
    return node;
  },
  createEdge: async (edge: Record<string, unknown>) => {
    createdEdges.push(edge);
    return edge;
  },
};

vi.mock("@/lib/storage", () => ({
  getStorageById: async () => fakeStorage,
}));

import {
  proposeCandidate,
  listCandidates,
  acceptCandidate,
  dismissCandidate,
  sendToReprocess,
  setCandidateStatus,
  IngestCandidateError,
} from "./candidates";

describe("proposeCandidate / listCandidates / acceptCandidate / dismissCandidate", () => {
  afterEach(() => {
    table = [];
    nextId = 1;
    createdNodes.length = 0;
    createdEdges.length = 0;
    fakeStorage = {
      backend: "supabase",
      workspace: { id: "ws-1", slug: "ws" },
      createNode: async (input: Record<string, unknown>) => {
        const node = { id: `node-${createdNodes.length + 1}`, ...input };
        createdNodes.push(node);
        return node;
      },
      createEdge: async (edge: Record<string, unknown>) => {
        createdEdges.push(edge);
        return edge;
      },
    };
  });

  it("creates a new pending candidate", async () => {
    const c = await proposeCandidate({
      workspaceId: "ws-1",
      source: "github",
      externalId: "pr-1",
      kind: "task",
      title: "Fix the thing",
      contentMd: "## Objetivo\n\nFix it.",
    });
    expect(c.status).toBe("pending");
    expect(c.workspace_id).toBe("ws-1");
  });

  it("re-proposing the same signal while pending overwrites the row instead of duplicating it", async () => {
    await proposeCandidate({
      workspaceId: "ws-1",
      source: "github",
      externalId: "pr-1",
      kind: "task",
      title: "Fix the thing",
      contentMd: "v1",
    });
    const updated = await proposeCandidate({
      workspaceId: "ws-1",
      source: "github",
      externalId: "pr-1",
      kind: "task",
      title: "Fix the thing (updated)",
      contentMd: "v2",
    });
    const all = await listCandidates("ws-1");
    expect(all).toHaveLength(1);
    expect(updated.title).toBe("Fix the thing (updated)");
    expect(updated.content_md).toBe("v2");
  });

  it("does not resurrect a dismissed candidate on redelivery", async () => {
    const c = await proposeCandidate({
      workspaceId: "ws-1",
      source: "github",
      externalId: "pr-2",
      kind: "bug",
      title: "Broken thing",
      contentMd: "v1",
    });
    await dismissCandidate("ws-1", c.id, "user-1");
    const redelivered = await proposeCandidate({
      workspaceId: "ws-1",
      source: "github",
      externalId: "pr-2",
      kind: "bug",
      title: "Broken thing (redelivered)",
      contentMd: "v2",
    });
    expect(redelivered.status).toBe("dismissed");
    expect(redelivered.title).toBe("Broken thing");
  });

  it("accept creates the node with ingest provenance stamped in data and marks the candidate accepted", async () => {
    const c = await proposeCandidate({
      workspaceId: "ws-1",
      source: "slack",
      externalId: "msg-1",
      kind: "decision",
      title: "We chose X",
      contentMd: "## Decisión\n\nX.",
    });
    const accepted = await acceptCandidate(fakeStorage as never, c.id, "user-1");
    expect(accepted.status).toBe("accepted");
    expect(accepted.created_node_id).toBe(createdNodes[0]!.id);
    expect(createdNodes[0]).toMatchObject({
      kind: "decision",
      title: "We chose X",
      data: {
        ingest_candidate_id: c.id,
        ingest_source: "slack",
        ingest_external_id: "msg-1",
      },
    });
  });

  it("accept creates declared links as edges from the new node", async () => {
    const c = await proposeCandidate({
      workspaceId: "ws-1",
      source: "github",
      externalId: "pr-3",
      kind: "task",
      title: "Follow-up task",
      contentMd: "## Objetivo\n\nFollow up.",
      links: [{ to_node_id: "node-parent", relation: "blocked_by" }],
    });
    const accepted = await acceptCandidate(fakeStorage as never, c.id, null);
    expect(createdEdges).toEqual([
      { from_node: accepted.created_node_id, to_node: "node-parent", relation: "blocked_by" },
    ]);
  });

  it("rejects accepting a non-pending candidate", async () => {
    const c = await proposeCandidate({
      workspaceId: "ws-1",
      source: "github",
      externalId: "pr-4",
      kind: "task",
      title: "Task",
      contentMd: "md",
    });
    await dismissCandidate("ws-1", c.id, "user-1");
    await expect(acceptCandidate(fakeStorage as never, c.id, "user-1")).rejects.toThrow(IngestCandidateError);
  });

  it("autoAccept: true proposes and immediately accepts in one call", async () => {
    const c = await proposeCandidate({
      workspaceId: "ws-1",
      source: "github",
      externalId: "pr-5",
      kind: "task",
      title: "Auto-accepted",
      contentMd: "md",
      autoAccept: true,
    });
    expect(c.status).toBe("accepted");
    expect(createdNodes).toHaveLength(1);
  });

  it("listCandidates filters by status", async () => {
    const a = await proposeCandidate({
      workspaceId: "ws-1",
      source: "github",
      externalId: "pr-6",
      kind: "task",
      title: "A",
      contentMd: "md",
    });
    await proposeCandidate({
      workspaceId: "ws-1",
      source: "github",
      externalId: "pr-7",
      kind: "task",
      title: "B",
      contentMd: "md",
    });
    await dismissCandidate("ws-1", a.id, null);
    const pending = await listCandidates("ws-1", { status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.title).toBe("B");
  });

  it("sendToReprocess moves a pending candidate to reprocess and records feedback", async () => {
    const c = await proposeCandidate({
      workspaceId: "ws-1",
      source: "github",
      externalId: "pr-8",
      kind: "task",
      title: "Needs another pass",
      contentMd: "md",
    });
    const reprocessed = await sendToReprocess("ws-1", c.id, "user-1", "missing context");
    expect(reprocessed.status).toBe("reprocess");
    expect(reprocessed.reprocess_feedback).toBe("missing context");
  });

  it("sendToReprocess rejects an already-accepted candidate", async () => {
    const c = await proposeCandidate({
      workspaceId: "ws-1",
      source: "github",
      externalId: "pr-9",
      kind: "task",
      title: "Already accepted",
      contentMd: "md",
    });
    await acceptCandidate(fakeStorage as never, c.id, "user-1");
    await expect(sendToReprocess("ws-1", c.id, "user-1", null)).rejects.toThrow(IngestCandidateError);
  });

  describe("setCandidateStatus (Procesamiento board — all 4 transitions)", () => {
    it("moving to accepted delegates to acceptCandidate (creates the node)", async () => {
      const c = await proposeCandidate({
        workspaceId: "ws-1",
        source: "github",
        externalId: "pr-10",
        kind: "task",
        title: "Board-accepted",
        contentMd: "md",
      });
      const updated = await setCandidateStatus(fakeStorage as never, c.id, "accepted", "user-1");
      expect(updated.status).toBe("accepted");
      expect(updated.created_node_id).toBe(createdNodes[0]!.id);
    });

    it("moving to reprocess delegates to sendToReprocess (carries feedback)", async () => {
      const c = await proposeCandidate({
        workspaceId: "ws-1",
        source: "github",
        externalId: "pr-11",
        kind: "task",
        title: "Board-reprocessed",
        contentMd: "md",
      });
      const updated = await setCandidateStatus(fakeStorage as never, c.id, "reprocess", "user-1", "try again");
      expect(updated.status).toBe("reprocess");
      expect(updated.reprocess_feedback).toBe("try again");
    });

    it("moving to dismissed is a plain status update, clearing any prior reprocess_feedback", async () => {
      const c = await proposeCandidate({
        workspaceId: "ws-1",
        source: "github",
        externalId: "pr-12",
        kind: "task",
        title: "Board-dismissed",
        contentMd: "md",
      });
      await setCandidateStatus(fakeStorage as never, c.id, "reprocess", "user-1", "needs work");
      const updated = await setCandidateStatus(fakeStorage as never, c.id, "dismissed", "user-1");
      expect(updated.status).toBe("dismissed");
      expect(updated.reprocess_feedback).toBeNull();
    });

    it("moving back to pending is allowed (undo a reprocess/dismiss)", async () => {
      const c = await proposeCandidate({
        workspaceId: "ws-1",
        source: "github",
        externalId: "pr-13",
        kind: "task",
        title: "Board-back-to-pending",
        contentMd: "md",
      });
      await setCandidateStatus(fakeStorage as never, c.id, "dismissed", "user-1");
      const updated = await setCandidateStatus(fakeStorage as never, c.id, "pending", "user-1");
      expect(updated.status).toBe("pending");
    });

    it("rejects any transition once a candidate is already accepted", async () => {
      const c = await proposeCandidate({
        workspaceId: "ws-1",
        source: "github",
        externalId: "pr-14",
        kind: "task",
        title: "Board-immutable",
        contentMd: "md",
      });
      await setCandidateStatus(fakeStorage as never, c.id, "accepted", "user-1");
      await expect(setCandidateStatus(fakeStorage as never, c.id, "pending", "user-1")).rejects.toThrow(IngestCandidateError);
    });
  });
});

describe("candidates are scoped to the authorised workspace", () => {
  it("refuses to accept a candidate belonging to another workspace", async () => {
    // The bug this pins: the route authorises the workspace in the request body,
    // but the candidate id also comes from the caller. Looking the candidate up
    // by id alone let a principal authorised for its own workspace name one from
    // another tenant — reading its full content_md back and materialising a node
    // into *that* tenant's workspace. Same shape as the /api/embed IDOR.
    const c = await proposeCandidate({
      workspaceId: "ws-other",
      source: "slack",
      externalId: "x-1",
      kind: "task",
      title: "another tenant's candidate",
      contentMd: "secret",
    });

    // fakeStorage is authorised for ws-1, the candidate lives in ws-other.
    await expect(acceptCandidate(fakeStorage as never, c.id, "user-1")).rejects.toThrow(
      IngestCandidateError,
    );
    expect(createdNodes).toHaveLength(0);
  });

  it("refuses to dismiss a candidate belonging to another workspace", async () => {
    const c = await proposeCandidate({
      workspaceId: "ws-other",
      source: "slack",
      externalId: "x-2",
      kind: "task",
      title: "another tenant's candidate",
      contentMd: "secret",
    });
    await expect(dismissCandidate("ws-1", c.id, "user-1")).rejects.toThrow(IngestCandidateError);
  });
});
