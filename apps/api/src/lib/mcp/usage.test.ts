import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn(async () => ({ error: null as { message: string } | null }));
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({ rpc }),
}));

import {
  flushMcpUsage,
  pendingMcpUsageBuckets,
  recordMcpToolCall,
} from "./usage";

const WS = "11111111-2222-3333-4444-555555555555";

describe("recordMcpToolCall", () => {
  beforeEach(() => {
    rpc.mockClear();
    rpc.mockImplementation(async () => ({ error: null }));
  });

  afterEach(async () => {
    rpc.mockImplementation(async () => ({ error: null }));
    await flushMcpUsage();
  });

  it("writes nothing while recording: a read never waits on the counter", () => {
    recordMcpToolCall(WS, "nodes");
    expect(rpc).not.toHaveBeenCalled();
    expect(pendingMcpUsageBuckets()).toBe(1);
  });

  it("collapses repeated calls into one bucket and one write", async () => {
    recordMcpToolCall(WS, "nodes");
    recordMcpToolCall(WS, "nodes");
    recordMcpToolCall(WS, "ping");
    expect(pendingMcpUsageBuckets()).toBe(2);

    await flushMcpUsage();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith(
      "increment_mcp_usage",
      expect.objectContaining({ p_workspace_id: WS, p_tool: "nodes", p_calls: 2 }),
    );
    expect(pendingMcpUsageBuckets()).toBe(0);
  });

  it("buckets by the UTC YYYY-MM the counters use", async () => {
    recordMcpToolCall(WS, "nodes", {}, new Date("2026-03-31T23:30:00Z"));
    await flushMcpUsage();
    expect(rpc).toHaveBeenCalledWith(
      "increment_mcp_usage",
      expect.objectContaining({ p_period: "2026-03" }),
    );
  });

  it("skips workspaces with no row to reference, such as the demo store", () => {
    recordMcpToolCall("demo", "nodes");
    recordMcpToolCall("", "nodes");
    expect(pendingMcpUsageBuckets()).toBe(0);
  });

  it("keeps the counts when the write fails, instead of losing them", async () => {
    rpc.mockImplementation(async () => ({ error: { message: "boom" } }));
    recordMcpToolCall(WS, "nodes");
    await expect(flushMcpUsage()).resolves.toBeUndefined();
    expect(pendingMcpUsageBuckets()).toBe(1);
  });
});
