import { afterEach, describe, expect, it, vi } from "vitest";

interface Row {
  [key: string]: unknown;
}

let nodesTable: Row[] = [];
let edgesTable: Row[] = [];
let readActivityTable: Row[] = [];

function makeAdmin() {
  return {
    from: (name: string) => {
      const table = name === "nodes" ? nodesTable : name === "edges" ? edgesTable : readActivityTable;
      const filters: Array<(row: Row) => boolean> = [];
      const builder = {
        select: () => builder,
        eq: (k: string, v: unknown) => {
          filters.push((row) => row[k] === v);
          return builder;
        },
        in: (k: string, values: unknown[]) => {
          filters.push((row) => values.includes(row[k]));
          return builder;
        },
        maybeSingle: async () => {
          const row = table.find((r) => filters.every((f) => f(r))) ?? null;
          return { data: row, error: null };
        },
        update: (patch: Row) => ({
          eq: (k: string, v: unknown) => {
            const row = table.find((r) => r[k] === v);
            if (row) Object.assign(row, patch);
            return Promise.resolve({ data: row ?? null, error: null });
          },
        }),
        insert: (payload: Row) => {
          table.push({ ...payload });
          return Promise.resolve({ data: payload, error: null });
        },
        then: (resolve: (r: { data: Row[]; error: null }) => void) => {
          const rows = table.filter((r) => filters.every((f) => f(r)));
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

import {
  computeStalenessScore,
  isStale,
  recordNodeRead,
  annotateStaleness,
  STALE_AGE_DAYS,
} from "./staleness";
import type { RagHit } from "@/lib/rag";

function hit(overrides: Partial<RagHit> = {}): RagHit {
  return {
    node_id: "node-1",
    title: "T",
    kind: "doc",
    content: "c",
    similarity: 0.9,
    chunk_index: null,
    block_id: null,
    ...overrides,
  };
}

describe("computeStalenessScore / isStale", () => {
  const now = Date.parse("2026-07-19T00:00:00.000Z");

  it("returns 0 for a just-edited node", () => {
    expect(computeStalenessScore({ updatedAt: new Date(now).toISOString() }, now)).toBe(0);
  });

  it("returns 1 for a node unedited for the full stale window", () => {
    const old = new Date(now - STALE_AGE_DAYS * 86_400_000).toISOString();
    expect(computeStalenessScore({ updatedAt: old }, now)).toBe(1);
  });

  it("halves the score when the node was read recently", () => {
    const old = new Date(now - STALE_AGE_DAYS * 86_400_000).toISOString();
    const recentRead = new Date(now - 5 * 86_400_000).toISOString();
    expect(computeStalenessScore({ updatedAt: old, lastReadAt: recentRead }, now)).toBe(0.5);
  });

  it("does not dampen the score when the last read is outside the active window", () => {
    const old = new Date(now - STALE_AGE_DAYS * 86_400_000).toISOString();
    const staleRead = new Date(now - 90 * 86_400_000).toISOString();
    expect(computeStalenessScore({ updatedAt: old, lastReadAt: staleRead }, now)).toBe(1);
  });

  it("isStale respects the threshold", () => {
    expect(isStale(0.69)).toBe(false);
    expect(isStale(0.7)).toBe(true);
  });
});

describe("recordNodeRead", () => {
  afterEach(() => {
    nodesTable = [];
    edgesTable = [];
    readActivityTable = [];
  });

  it("inserts a new row on first read", async () => {
    await recordNodeRead("ws-1", "node-1");
    expect(readActivityTable).toHaveLength(1);
    expect(readActivityTable[0]).toMatchObject({ node_id: "node-1", workspace_id: "ws-1", read_count: 1 });
  });

  it("increments read_count on subsequent reads", async () => {
    await recordNodeRead("ws-1", "node-1");
    await recordNodeRead("ws-1", "node-1");
    expect(readActivityTable).toHaveLength(1);
    expect(readActivityTable[0]!.read_count).toBe(2);
  });
});

describe("annotateStaleness", () => {
  afterEach(() => {
    nodesTable = [];
    edgesTable = [];
    readActivityTable = [];
  });

  it("returns hits unchanged when there is nothing to annotate", async () => {
    const out = await annotateStaleness("ws-1", []);
    expect(out).toEqual([]);
  });

  it("flags a superseded hit, degrades its rank, and never drops it", async () => {
    nodesTable = [
      { id: "old", updated_at: new Date(0).toISOString() },
      { id: "new", updated_at: new Date().toISOString() },
    ];
    edgesTable = [{ from_node: "new", to_node: "old", relation: "supersedes" }];
    const hits = [hit({ node_id: "old", similarity: 0.9 }), hit({ node_id: "new", similarity: 0.5 })];

    const out = await annotateStaleness("ws-1", hits);
    const oldHit = out.find((h) => h.node_id === "old")!;
    expect(oldHit.superseded_by).toBe("new");
    expect(oldHit.similarity).toBeLessThan(0.9);
  });

  it("flags a stale hit and applies the (smaller) stale penalty", async () => {
    const old = new Date(Date.now() - STALE_AGE_DAYS * 86_400_000).toISOString();
    nodesTable = [{ id: "node-1", updated_at: old }];
    const hits = [hit({ node_id: "node-1", similarity: 0.8 })];

    const out = await annotateStaleness("ws-1", hits);
    expect(out[0]!.stale).toBe(true);
    expect(out[0]!.superseded_by).toBeNull();
    expect(out[0]!.similarity).toBeCloseTo(0.8 * 0.85, 4);
  });

  it("re-sorts hits by the adjusted similarity", async () => {
    const old = new Date(Date.now() - STALE_AGE_DAYS * 86_400_000).toISOString();
    const fresh = new Date().toISOString();
    nodesTable = [
      { id: "stale-but-first", updated_at: old },
      { id: "fresh-but-second", updated_at: fresh },
    ];
    const hits = [
      hit({ node_id: "stale-but-first", similarity: 0.9 }),
      hit({ node_id: "fresh-but-second", similarity: 0.85 }),
    ];
    const out = await annotateStaleness("ws-1", hits);
    expect(out[0]!.node_id).toBe("fresh-but-second");
  });

  it("leaves a hit unannotated when its node has no updated_at on record", async () => {
    nodesTable = [];
    const hits = [hit({ node_id: "unknown", similarity: 0.7 })];
    const out = await annotateStaleness("ws-1", hits);
    expect(out[0]!.similarity).toBe(0.7);
    expect(out[0]!.stale).toBeUndefined();
  });
});
