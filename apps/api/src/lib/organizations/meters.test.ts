import { describe, expect, it } from "vitest";

import {
  aggregateOrgCounters,
  currentPeriod,
  isFlowUsageKind,
  type OrgCounterRow,
} from "./meters";

const row = (
  user_id: string,
  kind: string,
  count: number | null,
): OrgCounterRow => ({ user_id, kind, count });

describe("aggregateOrgCounters", () => {
  it("reports every flow meter even when nothing was consumed", () => {
    const totals = aggregateOrgCounters([]);
    expect([...totals.keys()].sort()).toEqual([
      "ai_queries",
      "mcp_calls",
      "meeting_minutes",
    ]);
    expect(totals.get("ai_queries")?.total).toBe(0);
  });

  it("sums the organization's total and keeps the per-member split", () => {
    const totals = aggregateOrgCounters([
      row("u1", "ai_queries", 10),
      row("u2", "ai_queries", 5),
      row("u1", "mcp_calls", 900),
    ]);
    expect(totals.get("ai_queries")?.total).toBe(15);
    expect(totals.get("ai_queries")?.by_member.get("u1")).toBe(10);
    expect(totals.get("ai_queries")?.by_member.get("u2")).toBe(5);
    expect(totals.get("mcp_calls")?.total).toBe(900);
  });

  it("adds up rows that repeat a member — periods are one bucket per read", () => {
    const totals = aggregateOrgCounters([
      row("u1", "mcp_calls", 3),
      row("u1", "mcp_calls", 4),
    ]);
    expect(totals.get("mcp_calls")?.total).toBe(7);
    expect(totals.get("mcp_calls")?.by_member.get("u1")).toBe(7);
  });

  it("treats a null count as nothing consumed", () => {
    const totals = aggregateOrgCounters([row("u1", "ai_queries", null)]);
    expect(totals.get("ai_queries")?.total).toBe(0);
    expect(totals.get("ai_queries")?.by_member.get("u1")).toBe(0);
  });

  it("drops a kind that is not a flow meter", () => {
    const totals = aggregateOrgCounters([
      row("u1", "nodes", 40),
      row("u1", "something_else", 40),
    ]);
    expect(totals.has("nodes" as never)).toBe(false);
    expect([...totals.values()].every((m) => m.total === 0)).toBe(true);
  });
});

describe("isFlowUsageKind", () => {
  it("excludes nodes: a stock is counted, never accumulated", () => {
    expect(isFlowUsageKind("nodes")).toBe(false);
    expect(isFlowUsageKind("ai_queries")).toBe(true);
    expect(isFlowUsageKind("mcp_calls")).toBe(true);
    expect(isFlowUsageKind("meeting_minutes")).toBe(true);
  });
});

describe("currentPeriod", () => {
  it("buckets by UTC month", () => {
    expect(currentPeriod(new Date("2026-03-31T23:59:59Z"))).toBe("2026-03");
    expect(currentPeriod(new Date("2026-04-01T00:00:00Z"))).toBe("2026-04");
  });
});
