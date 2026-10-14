/**
 * The brief once objectives exist: what the workspace is aiming at, whether
 * the queue knows about it, and what happens when nobody reviews a goal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { resetDemoViewsForTests } from "@/lib/views/store";
import type { Storage } from "@/lib/storage";
import { goalCreateInput } from "@/lib/goals";
import { resetDemoBriefsForTests, type Brief, type BriefNode } from "./brief";

const mocks = vi.hoisted(() => ({ listAuthorizedCapabilityTools: vi.fn() }));
vi.mock("@/lib/capabilities/catalog", () => ({ listAuthorizedCapabilityTools: mocks.listAuthorizedCapabilityTools }));
vi.mock("@/lib/capabilities/gateway", () => ({ CapabilityGatewayError: class extends Error {}, invokeAuthorizedCapability: vi.fn() }));

import { buildMcpServer } from "./server";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
function body<T = Record<string, unknown>>(result: ToolResult): T {
  const text = (result as { content: Array<{ type: string; text?: string }> }).content[0]?.text ?? "";
  return JSON.parse(text) as T;
}

/** A window that is open today, whatever today is when the suite runs. */
const YEAR_MS = 365 * 86_400_000;
const started = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
const ends = new Date(Date.now() + YEAR_MS).toISOString().slice(0, 10);

describe("goals in the brief", () => {
  let client: Client;
  let close: () => Promise<void>;
  let storage: Storage;

  async function goal(
    title: string,
    opts: { status?: string; scope?: "company" | "project"; parent?: string; root?: boolean; horizon?: boolean; review?: "weekly" | "monthly"; kr?: boolean } = {},
  ) {
    return storage.createNode(
      await goalCreateInput(
        storage,
        {
          title,
          kind: "goal",
          parent_id: opts.parent ?? null,
          status: (opts.status ?? "on_track") as never,
          data: { ...(opts.root ? { root: true } : {}), ...(opts.scope ? { scope: opts.scope } : {}) },
        },
        {
          ...(opts.horizon === false ? {} : { horizon: { start: started, end: ends } }),
          ...(opts.review ? { review_every: opts.review } : {}),
          ...(opts.kr === false ? {} : { key_results: [{ name: "MRR", baseline: 0, target: 100, current: 25, direction: "increase" as const }] }),
        },
      ),
    );
  }

  async function task(title: string, priority: string, pushes?: string) {
    const node = await storage.createNode({ title, kind: "task", status: "todo", priority: priority as never, parent_id: null });
    if (pushes) await storage.createEdge({ from_node: node.id, to_node: pushes, relation: "contributes_to" });
    return node;
  }

  async function brief(top = 10): Promise<Brief> {
    return body<Brief>(await client.callTool({ name: "brief", arguments: { top } }));
  }

  beforeEach(async () => {
    resetDemoViewsForTests();
    resetDemoBriefsForTests();
    mocks.listAuthorizedCapabilityTools.mockReset().mockResolvedValue([]);
    const slug = `brief-goals-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = createWorkspace({ name: "Goals", slug });
    storage = resolveDemoStorage(slug)!;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer({
      workspaceId: workspace.id, workspaceRef: slug, scopes: ["nodes:read", "nodes:write"], tokenId: `t-${slug}`, tokenScope: "workspace", subjectUserId: null,
      agentId: "agent-1", agentLabel: "Planner",
      grant: { workspaceId: workspace.id, principal: { kind: "agent", id: "agent-1" }, verbs: ["read", "write", "goals:write"], reach: { type: "all" } } as never,
      storage,
    });
    client = new Client({ name: "t", version: "0" });
    await server.connect(st); await client.connect(ct);
    close = async () => { await client.close(); await server.close(); };
  });
  afterEach(async () => close());

  it("reports the active goals with their aggregated progress", async () => {
    const ns = await goal("Be the context layer", { root: true, horizon: false, kr: false });
    await goal("Triple revenue", { status: "at_risk" });

    const out = await brief();
    expect(out.goals.north_star?.id).toBe(ns.id);
    // The mission has no window and never expires, so it counts as active.
    expect(out.goals.total).toBe(2);
    expect(out.goals.top.map((g) => g.title)).toEqual(["Triple revenue"]);
    const revenue = out.goals.top[0]!;
    expect(revenue.progress).toBeCloseTo(0.25);
    expect(revenue.status).toBe("at_risk");
    expect(revenue.key_results).toBe(1);
  });

  it("says a goal has nothing measurable instead of calling it 0%", async () => {
    await goal("Be the context layer", { root: true, horizon: false, kr: false });
    const out = await brief();
    expect(out.goals.north_star?.progress).toBeNull();
    expect(out.goals.north_star?.progress_note).toMatch(/no key results/);
    // The distinction that matters: null is not zero.
    expect(out.goals.north_star?.progress).not.toBe(0);
  });

  it("leaves a closed window out of the active list", async () => {
    await goal("Last quarter", { horizon: false });
    const stale = await goal("Also last quarter", { horizon: false });
    await storage.updateNode(stale.id, {
      due_date: "2020-03-31",
      data: { ...(await storage.getNode(stale.id))!.data, timeframe: { start: "2020-01-01", cycle: "2020-Q1" } },
    });
    const out = await brief();
    expect(out.goals.top.map((g) => g.title)).toEqual(["Last quarter"]);
  });

  describe("the unblocked queue", () => {
    const cardFor = (out: Brief, id: string): BriefNode | undefined =>
      out.unblocked.top.find((node) => node.id === id);

    it("lets the objective break ties without touching the priority bands", async () => {
      const company = await goal("Triple revenue", { status: "off_track" });
      const pushing = await task("Fix billing", "low", company.id);
      const idle = await task("Tidy the docs", "low");
      const urgent = await task("Production is down", "urgent");

      const out = await brief();
      const order = out.unblocked.top.map((node) => node.id);
      // The band is untouchable: `urgent` first even though it pushes nothing.
      expect(order[0]).toBe(urgent.id);
      // Inside the `low` band the objective decides.
      expect(order.indexOf(pushing.id)).toBeLessThan(order.indexOf(idle.id));
      expect(cardFor(out, pushing.id)?.goal?.id).toBe(company.id);
      expect(cardFor(out, pushing.id)?.goal?.status).toBe("off_track");
      expect(cardFor(out, idle.id)?.goal).toBeUndefined();
    });

    it("does not sink work that belongs to no objective", async () => {
      const healthy = await goal("Ship the thing", { status: "on_track" });
      const first = await task("Unaffiliated, oldest", "med");
      const pushing = await task("Pushes a healthy goal", "med", healthy.id);
      const last = await task("Unaffiliated, newest", "med");

      // Belonging to an objective is not, by itself, a reason to go first: a
      // healthy goal exerts no pressure, so the three sit where the tiebreak
      // put them and the middle one stays the middle one.
      const healthyOrder = (await brief()).unblocked.top.map((node) => node.id);
      expect(healthyOrder.indexOf(pushing.id)).toBe(1);

      // Only distress promotes. The two unaffiliated tasks keep their own
      // order — they are not pushed to the bottom, just overtaken by one.
      await storage.updateNode(healthy.id, { status: "off_track" as never });
      const risky = (await brief()).unblocked.top.map((node) => node.id);
      expect(risky[0]).toBe(pushing.id);
      expect(risky.indexOf(first.id) < risky.indexOf(last.id)).toBe(
        healthyOrder.indexOf(first.id) < healthyOrder.indexOf(last.id),
      );
    });

    it("inherits urgency through the goal chain, and names where it came from", async () => {
      const company = await goal("Triple revenue", { status: "at_risk", scope: "company" });
      const project = await goal("Ship self-serve billing", { status: "on_track", parent: company.id });
      const deep = await task("Wire the webhook", "med", project.id);
      const shallow = await task("Something else", "med");

      const out = await brief();
      const order = out.unblocked.top.map((node) => node.id);
      expect(order.indexOf(deep.id)).toBeLessThan(order.indexOf(shallow.id));
      // The card names the goal the urgency came FROM, not the one linked to:
      // the project goal is fine, the company goal it feeds is not.
      expect(cardFor(out, deep.id)?.goal?.id).toBe(company.id);
    });
  });

  it("flags a goal that is past the cadence it declared", async () => {
    const overdue = await goal("Triple revenue", { review: "weekly" });
    await storage.updateNode(overdue.id, {
      data: { ...(await storage.getNode(overdue.id))!.data, last_reviewed_at: new Date(Date.now() - 21 * 86_400_000).toISOString() },
    });
    await goal("Reviewed yesterday", { review: "monthly" });

    const out = await brief();
    expect(out.goals.needs_review.map((g) => g.title)).toEqual(["Triple revenue"]);
    expect(out.goals.needs_review[0]!.review_overdue?.every).toBe("weekly");
    expect(out.goals.needs_review[0]!.review_overdue?.days).toBeGreaterThanOrEqual(13);
    // Flagged, never hidden: it is still in the active list too.
    expect(out.goals.top.map((g) => g.title)).toContain("Triple revenue");
  });

  it("never flags a goal that promised no cadence", async () => {
    await goal("No cadence declared");
    const out = await brief();
    expect(out.goals.needs_review).toEqual([]);
  });

  it("reports a write to a company goal as a strategic change, and stops once it is old news", async () => {
    const created = body<{ id: string }>(
      await client.callTool({ name: "goals_write", arguments: { op: "create", title: "Triple revenue", cycle: "2027-Q1" } }),
    );
    await client.callTool({
      name: "nodes_write",
      arguments: { op: "create", kind: "task", title: "Ordinary work", status: "todo" },
    });

    const first = await brief();
    expect(first.goals.strategic_changes.total).toBe(1);
    expect(first.goals.strategic_changes.top[0]!.node_id).toBe(created.id);
    expect(first.goals.strategic_changes.top[0]!.actor).toBe("Planner");
    // The same entry in the general feed carries the flag, so list_changes
    // shows it without a second definition of "strategic".
    const changes = body<{ changes: Array<{ node_id: string | null; strategic: boolean }> }>(
      await client.callTool({ name: "list_changes", arguments: {} }),
    );
    expect(changes.changes.find((entry) => entry.node_id === created.id)?.strategic).toBe(true);
    expect(changes.changes.find((entry) => entry.node_id !== created.id)?.strategic).toBe(false);

    // Second brief: `since` moved past it.
    const second = await brief();
    expect(second.goals.strategic_changes.total).toBe(0);
  });

  it("does not call a project goal's edit strategic", async () => {
    const company = await goal("Triple revenue", { status: "on_track" });
    await client.callTool({
      name: "goals_write",
      arguments: { op: "create", title: "Ship billing", contributes_to: company.id },
    });
    const out = await brief();
    // The company goal above was created straight on the store, so the only
    // recorded change is the project goal's.
    expect(out.goals.strategic_changes.total).toBe(0);
  });
});
