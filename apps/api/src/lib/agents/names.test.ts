import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  configured: true,
  rows: [] as Array<{ id: string; name: string | null }>,
  queries: 0,
  fail: false,
};

vi.mock("@bcontext-dev/contract/env", () => ({
  isSupabaseConfigured: () => state.configured,
}));
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        in: async (_col: string, ids: string[]) => {
          state.queries += 1;
          if (state.fail) return { data: null, error: { message: "down" } };
          return { data: state.rows.filter((row) => ids.includes(row.id)), error: null };
        },
      }),
    }),
  }),
}));

import { agentDisplayName, agentDisplayNames, resetAgentNameCacheForTests } from "./names";

beforeEach(() => {
  resetAgentNameCacheForTests();
  state.configured = true;
  state.rows = [
    { id: "a1", name: "Codex release agent" },
    { id: "a2", name: "Reviewer" },
  ];
  state.queries = 0;
  state.fail = false;
});
afterEach(() => resetAgentNameCacheForTests());

describe("agent display names", () => {
  it("resolves a page of ids in one query and caches the answer", async () => {
    const names = await agentDisplayNames(["a1", "a2", "a1", "missing"]);
    expect([...names.entries()]).toEqual([["a1", "Codex release agent"], ["a2", "Reviewer"]]);
    expect(state.queries).toBe(1);
    // Hits and known misses are both cached: a deleted agent that still
    // appears in the feed does not cost a query per page.
    await agentDisplayNames(["a1", "missing"]);
    expect(state.queries).toBe(1);
    expect(await agentDisplayName("a2")).toBe("Reviewer");
    expect(state.queries).toBe(1);
  });

  it("never throws: a failed lookup reads as unknown and is retried next time", async () => {
    state.fail = true;
    expect(await agentDisplayName("a1")).toBeNull();
    state.fail = false;
    expect(await agentDisplayName("a1")).toBe("Codex release agent");
    expect(state.queries).toBe(2);
  });

  it("does nothing without Supabase, and for empty input", async () => {
    state.configured = false;
    expect(await agentDisplayName("a1")).toBeNull();
    expect(await agentDisplayName(null)).toBeNull();
    expect(state.queries).toBe(0);
  });
});
