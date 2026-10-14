/**
 * Goals over MCP: an objective created with its key results in one call, the
 * tree read back with its progress, and a check-in that moves one number
 * without re-sending anything else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import type { Storage } from "@/lib/storage";

const mocks = vi.hoisted(() => ({ listAuthorizedCapabilityTools: vi.fn() }));
vi.mock("@/lib/capabilities/catalog", () => ({ listAuthorizedCapabilityTools: mocks.listAuthorizedCapabilityTools }));
vi.mock("@/lib/capabilities/gateway", () => ({ CapabilityGatewayError: class extends Error {}, invokeAuthorizedCapability: vi.fn() }));

import { buildMcpServer } from "./server";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
function text(result: ToolResult): string {
  return (result as { content: Array<{ type: string; text?: string }> }).content[0]?.text ?? "";
}
function body<T = Record<string, unknown>>(result: ToolResult): T {
  return JSON.parse(text(result)) as T;
}

interface KeyResultCard { id: string; name: string; current: number; progress: number | null }
interface GoalCard {
  id: string;
  title: string;
  scope: string | null;
  root: boolean;
  due_date: string | null;
  cycle: string | null;
  health: { status: string | null; progress: number | null; pace: string | null };
  key_results: KeyResultCard[];
  children: GoalCard[];
}

describe("goals over MCP", () => {
  let client: Client;
  let close: () => Promise<void>;
  let storage: Storage;

  beforeEach(async () => {
    mocks.listAuthorizedCapabilityTools.mockReset().mockResolvedValue([]);
    const slug = `mcp-goals-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = createWorkspace({ name: "Goals", slug });
    storage = resolveDemoStorage(slug)!;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer({
      workspaceId: workspace.id, workspaceRef: slug, scopes: ["nodes:read", "nodes:write"], tokenId: "t", tokenScope: "workspace", subjectUserId: null,
      grant: { workspaceId: workspace.id, principal: { kind: "agent", id: "a" }, verbs: ["read", "write", "goals:write"], reach: { type: "all" } } as never,
      storage,
    });
    client = new Client({ name: "t", version: "0" });
    await server.connect(st); await client.connect(ct);
    close = async () => { await client.close(); await server.close(); };
  });
  afterEach(async () => close());

  async function write(args: Record<string, unknown>): Promise<ToolResult> {
    return client.callTool({ name: "goals_write", arguments: args });
  }

  it("creates a goal with its key results and its horizon in one call", async () => {
    const res = await write({
      op: "create",
      title: "Triple revenue",
      cycle: "2027-Q1",
      key_results: [
        { name: "MRR", unit: "EUR", baseline: 10000, target: 30000, direction: "increase" },
        { name: "Churn", unit: "%", baseline: 6, target: 3, direction: "decrease" },
      ],
    });
    expect(res.isError).toBeFalsy();
    const created = body<{ id: string; goal: GoalCard }>(res);
    expect(created.goal.scope).toBe("company");
    expect(created.goal.cycle).toBe("2027-Q1");
    expect(created.goal.due_date).toBe("2027-03-31");
    expect(created.goal.key_results.map((kr) => kr.name)).toEqual(["MRR", "Churn"]);

    // The body is the goal skeleton, so every goal answers the same questions.
    const node = await storage.getNode(created.id);
    expect(node?.content_md).toContain("## Definition of done");
    expect(node?.content_md).toContain("## Review log");
    expect(node?.status).toBe("on_track");
  });

  it("hangs a company goal off the North Star and a contributor under what it pushes", async () => {
    const ns = body<{ id: string }>(
      await client.callTool({
        name: "nodes_write",
        arguments: { op: "create", kind: "goal", title: "Be the context layer", content_md: "## Why now\n\nBecause." },
      }),
    );
    // Created through nodes_write, and still resolved: the two paths agree.
    const nsNode = await storage.getNode(ns.id);
    expect((nsNode?.data as { scope?: string }).scope).toBe("company");
    await storage.updateNode(ns.id, { data: { ...nsNode!.data, root: true } });

    const company = body<{ id: string; goal: GoalCard }>(await write({ op: "create", title: "Triple revenue" }));
    expect((await storage.getNode(company.id))?.parent_id).toBe(ns.id);

    const project = body<{ id: string; goal: GoalCard }>(
      await write({ op: "create", title: "Ship self-serve billing", contributes_to: company.id }),
    );
    expect(project.goal.scope).toBe("project");
    const edges = await storage.listEdges();
    expect(edges).toContainEqual({ from_node: project.id, to_node: company.id, relation: "contributes_to" });
  });

  it("moves one key result without touching the body or the others", async () => {
    const created = body<{ id: string; goal: GoalCard }>(
      await write({
        op: "create",
        title: "Triple revenue",
        content_md: "## Why now\n\nThe market is moving.",
        cycle: "2027-Q1",
        key_results: [
          { name: "MRR", baseline: 0, target: 100, direction: "increase" },
          { name: "Logos", baseline: 0, target: 10, direction: "increase" },
        ],
      }),
    );
    const [mrr, logos] = created.goal.key_results;

    const res = await write({ op: "checkin", id: created.id, key_result_id: mrr!.id, current: 60, status: "at_risk" });
    expect(res.isError).toBeFalsy();
    const after = body<{ status: string; progress: number; key_results: KeyResultCard[] }>(res);
    expect(after.status).toBe("at_risk");
    // 60% of one, nothing of the other.
    expect(after.progress).toBeCloseTo(0.3);
    expect(after.key_results.find((kr) => kr.id === logos!.id)?.current).toBe(0);

    const node = await storage.getNode(created.id);
    expect(node?.content_md).toContain("The market is moving.");
  });

  it("reads the tree, one goal by id, and filters by scope", async () => {
    const company = body<{ id: string }>(await write({ op: "create", title: "Triple revenue", cycle: "2027-Q1" }));
    await write({ op: "create", title: "Ship billing", parent_id: company.id, cycle: "2027-Q1" });

    const tree = body<{ total: number; tree: GoalCard[] }>(
      await client.callTool({ name: "goals", arguments: { include_inactive: true } }),
    );
    expect(tree.total).toBe(2);
    expect(tree.tree).toHaveLength(1);
    expect(tree.tree[0]!.children[0]!.title).toBe("Ship billing");

    const one = body<{ goal: GoalCard }>(await client.callTool({ name: "goals", arguments: { id: company.id } }));
    expect(one.goal.title).toBe("Triple revenue");

    const projects = body<{ total: number }>(
      await client.callTool({ name: "goals", arguments: { scope: "project", include_inactive: true } }),
    );
    expect(projects.total).toBe(1);
  });

  it("says which argument an op is missing instead of failing silently", async () => {
    const created = body<{ id: string }>(await write({ op: "create", title: "Triple revenue" }));
    expect(text(await write({ op: "checkin", id: created.id, current: 3 }))).toContain("key_result_id");
    expect(text(await write({ op: "checkin", id: created.id, key_result_id: "k1" }))).toContain("current");
    expect(text(await write({ op: "update", title: "No id" }))).toContain("id");
    expect(text(await write({ op: "add_kr", id: created.id, kr: { name: "MRR" } }))).toContain("baseline");
  });
});
