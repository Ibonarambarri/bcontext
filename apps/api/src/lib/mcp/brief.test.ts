/**
 * `brief`: the first call of a session. One read, a fixed shape, and a
 * `since` the server remembers per token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { resetDemoViewsForTests } from "@/lib/views/store";
import type { Storage } from "@/lib/storage";
import { resetDemoBriefsForTests, type Brief } from "./brief";

const mocks = vi.hoisted(() => ({ listAuthorizedCapabilityTools: vi.fn() }));
vi.mock("@/lib/capabilities/catalog", () => ({ listAuthorizedCapabilityTools: mocks.listAuthorizedCapabilityTools }));
vi.mock("@/lib/capabilities/gateway", () => ({ CapabilityGatewayError: class extends Error {}, invokeAuthorizedCapability: vi.fn() }));

import { buildMcpServer, visibleTools } from "./server";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
function text(result: ToolResult): string {
  return (result as { content: Array<{ type: string; text?: string }> }).content[0]?.text ?? "";
}
function body<T = Record<string, unknown>>(result: ToolResult): T {
  return JSON.parse(text(result)) as T;
}

describe("brief over MCP", () => {
  let client: Client;
  let close: () => Promise<void>;
  let storage: Storage;
  let ids: Record<string, string>;

  beforeEach(async () => {
    resetDemoViewsForTests();
    resetDemoBriefsForTests();
    mocks.listAuthorizedCapabilityTools.mockReset().mockResolvedValue([]);
    const slug = `mcp-brief-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = createWorkspace({ name: "Brief", slug });
    storage = resolveDemoStorage(slug)!;
    const urgent = await storage.createNode({ title: "Urgent task", kind: "task", status: "todo", priority: "urgent", content_md: "", parent_id: null });
    const low = await storage.createNode({ title: "Low task", kind: "task", status: "in_progress", priority: "low", content_md: "", parent_id: null });
    const blocked = await storage.createNode({ title: "Blocked task", kind: "task", status: "todo", priority: "high", content_md: "", parent_id: null });
    await storage.createNode({ title: "Done task", kind: "task", status: "done", content_md: "", parent_id: null });
    await storage.createNode({ title: "Shelved", kind: "task", status: "archived", content_md: "", parent_id: null });
    const open = await storage.createNode({ title: "Pricing model", kind: "decision", status: "review", content_md: "", parent_id: null });
    await storage.createNode({ title: "Decided long ago", kind: "decision", status: null, content_md: "", parent_id: null });
    await storage.createNode({ title: "Notes", kind: "doc", status: null, content_md: "", parent_id: null });
    await storage.createEdge({ from_node: blocked.id, to_node: low.id, relation: "blocked_by" });
    // Assignment has no MCP write today (assignee_id is a person); set it
    // straight on the store so "for_you" has something to find.
    await storage.updateNode(urgent.id, { assignee_id: "agent-1" } as never);
    ids = { urgent: urgent.id, low: low.id, blocked: blocked.id, open: open.id };

    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer({
      workspaceId: workspace.id, workspaceRef: slug, scopes: ["nodes:read", "nodes:write"], tokenId: `brief-token-${slug}`, tokenScope: "workspace", subjectUserId: null,
      agentId: "agent-1", agentLabel: "Planner",
      grant: { workspaceId: workspace.id, principal: { kind: "agent", id: "agent-1" }, verbs: ["read", "write"], reach: { type: "all" } } as never,
      storage,
    });
    client = new Client({ name: "t", version: "0" });
    await server.connect(st); await client.connect(ct);
    close = async () => { await client.close(); await server.close(); };
  });
  afterEach(async () => close());

  it("is a read tool every reader sees", () => {
    const reader = visibleTools({ workspaceId: "ws", principal: { kind: "agent", id: "a" }, verbs: ["read"], reach: { type: "all" } }).map((t) => t.name);
    expect(reader).toContain("brief");
  });

  it("returns counts, the unblocked queue by priority, open decisions, what is assigned to me and the views", async () => {
    const res = await client.callTool({ name: "brief", arguments: { top: 2 } });
    expect(res.isError).toBeFalsy();
    const brief = body<Brief>(res);

    expect(brief.counts.nodes).toBe(7); // archived is not live
    expect(brief.counts.by_kind).toEqual({ decision: 2, doc: 1, task: 4 });
    expect(brief.counts.by_status).toEqual({ archived: 1, done: 1, in_progress: 1, review: 1, todo: 2 });

    // urgent first, then the in-progress low; the blocked one is out and
    // `top` caps the list while `total` still says how long it is.
    expect(brief.unblocked.total).toBe(3);
    expect(brief.unblocked.top.map((n) => n.id)).toEqual([ids.urgent, ids.low]);
    expect(brief.unblocked.top[0]).toMatchObject({ title: "Urgent task", priority: "urgent", status: "todo", kind: "task" });

    expect(brief.open_decisions.total).toBe(1);
    expect(brief.open_decisions.top[0]!.id).toBe(ids.open);

    expect(brief.for_you.total).toBe(1);
    expect(brief.for_you.top[0]!.id).toBe(ids.urgent);

    expect(brief.views.length).toBeGreaterThan(0);
    expect(brief.views[0]).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String), renderer: expect.any(String) }));
  });

  it("remembers since per token: the second brief covers only what happened after the first", async () => {
    const first = body<Brief>(await client.callTool({ name: "brief", arguments: {} }));
    expect(first.since).toBeNull();

    await new Promise((r) => setTimeout(r, 2));
    const written = body<{ id: string }>(await client.callTool({
      name: "nodes_write", arguments: { op: "create", kind: "task", title: "Written after the brief", content_md: "## Goal\n\nx" },
    }));

    const second = body<Brief>(await client.callTool({ name: "brief", arguments: {} }));
    expect(second.since).toBe(first.generated_at);
    expect(second.changes.since).toBe(first.generated_at);
    expect(second.changes.entries.map((e) => e.node_id)).toEqual([written.id]);
    expect(second.changes.entries[0]).toMatchObject({ action: "create", title: "Written after the brief", actor: "Planner" });
    expect(second.changes.more).toBe(false);

    // An explicit since overrides the remembered one.
    const override = body<Brief>(await client.callTool({ name: "brief", arguments: { since: "2000-01-01T00:00:00.000Z" } }));
    expect(override.since).toBe("2000-01-01T00:00:00.000Z");
    expect(override.changes.entries.length).toBeGreaterThanOrEqual(1);
  });
});
