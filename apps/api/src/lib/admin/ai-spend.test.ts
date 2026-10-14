import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The per-organization AI spend the admin panel prints. What matters: the
 * sum comes from the database (one call per window, whatever the page
 * size), PostgREST's stringly numerics become numbers, and a ledger that
 * cannot be read is reported as unavailable rather than as zero dollars.
 */
type Call = { fn: string; args: Record<string, unknown> };
const calls: Call[] = [];
let rows: Array<Record<string, unknown>> | null = [];
let rpcError: { message: string } | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (rpcError) return { data: null, error: rpcError };
      // The window read answers with the subset the arguments ask for.
      const since = args.p_since as string | null;
      return {
        data: (rows ?? []).filter((r) => !since || (r.created_at as string) >= since),
        error: null,
      };
    },
  }),
}));
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { fetchOrgAiSpend, sumAiCostUsd } from "./ai-spend";

const NOW = new Date("2026-09-16T12:00:00.000Z");

afterEach(() => {
  calls.length = 0;
  rows = [];
  rpcError = null;
});

describe("fetchOrgAiSpend", () => {
  it("asks the database for the sum, twice, for exactly the page's organizations", async () => {
    rows = [
      { organization_id: "org-a", events: "12", cost_usd: "0.433519", unpriced_events: "2", created_at: "2026-09-01" },
      { organization_id: "org-b", events: "3", cost_usd: "0.100000", unpriced_events: "0", created_at: "2026-01-01" },
    ];
    const { available, byOrg } = await fetchOrgAiSpend(["org-a", "org-b", "org-c"], NOW);
    expect(available).toBe(true);
    expect(calls.map((c) => c.fn)).toEqual(["admin_ai_spend", "admin_ai_spend"]);
    expect(calls[0]!.args).toMatchObject({ p_since: null, p_organization_ids: ["org-a", "org-b", "org-c"] });
    expect(calls[1]!.args).toMatchObject({
      p_since: "2026-08-17T12:00:00.000Z",
      p_organization_ids: ["org-a", "org-b", "org-c"],
    });
    // PostgREST hands numerics back as strings; the panel gets numbers.
    expect(byOrg.get("org-a")).toEqual({
      total_usd: 0.433519,
      total_events: 12,
      last_30d_usd: 0.433519,
      last_30d_events: 12,
      unpriced_events: 2,
    });
    // Spent long ago: in the total, nothing in the window.
    expect(byOrg.get("org-b")).toEqual({
      total_usd: 0.1,
      total_events: 3,
      last_30d_usd: 0,
      last_30d_events: 0,
      unpriced_events: 0,
    });
    // No events, no row: the caller prints zero.
    expect(byOrg.has("org-c")).toBe(false);
  });

  it("reads nothing for an empty page", async () => {
    const { available, byOrg } = await fetchOrgAiSpend([], NOW);
    expect(available).toBe(true);
    expect(byOrg.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it("says the ledger is unavailable instead of pretending nobody spent anything", async () => {
    rpcError = { message: "function admin_ai_spend does not exist" };
    const { available, byOrg } = await fetchOrgAiSpend(["org-a"], NOW);
    expect(available).toBe(false);
    expect(byOrg.size).toBe(0);
  });
});

describe("sumAiCostUsd", () => {
  it("adds every organization's cost in the window, bounded on both sides", async () => {
    rows = [
      { organization_id: "org-a", events: "1", cost_usd: "0.25", unpriced_events: "0", created_at: "2026-09-02" },
      { organization_id: "org-b", events: "1", cost_usd: "0.1000005", unpriced_events: "0", created_at: "2026-09-03" },
    ];
    const from = new Date("2026-09-01T00:00:00.000Z");
    const to = new Date("2026-10-01T00:00:00.000Z");
    expect(await sumAiCostUsd(from, to)).toBe(0.350001);
    expect(calls[0]!.args).toMatchObject({
      p_since: from.toISOString(),
      p_until: to.toISOString(),
      p_organization_ids: null,
    });
  });

  it("is null when the ledger cannot be read, so the dashboard can say so", async () => {
    rpcError = { message: "boom" };
    expect(await sumAiCostUsd(new Date(0), NOW)).toBeNull();
  });
});
