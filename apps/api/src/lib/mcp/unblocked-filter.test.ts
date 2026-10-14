/**
 * One filter: a saved view with `unblocked: true` and nodes(op=list,
 * unblocked: true) are the same list. Both go through `matchViewQuery`, and
 * this pins it, together with the merge rule for `query` on list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { resetDemoViewsForTests } from "@/lib/views/store";
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
const sorted = (ids: string[]) => [...ids].sort((a, b) => a.localeCompare(b));

describe("unblocked: one rule for views and nodes(op=list)", () => {
  let client: Client;
  let close: () => Promise<void>;
  let storage: Storage;
  let ids: Record<string, string>;

  beforeEach(async () => {
    resetDemoViewsForTests();
    mocks.listAuthorizedCapabilityTools.mockReset().mockResolvedValue([]);
    const slug = `mcp-unblocked-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = createWorkspace({ name: "Unblocked", slug });
    storage = resolveDemoStorage(slug)!;
    const make = (title: string, kind: "task" | "bug" | "doc" | "decision", status: "todo" | "in_progress" | "done" | "archived" | null, priority: "high" | "low" | null = null) =>
      storage.createNode({ title, kind, status, priority, content_md: "", parent_id: null });
    const free = await make("Free", "task", "todo", "high");
    const waiting = await make("Waiting", "task", "todo");
    const doneBlocker = await make("Done blocker", "task", "done");
    const archivedBlocker = await make("Archived blocker", "task", "archived");
    const liveBlocker = await make("Live blocker", "bug", "in_progress", "low");
    const afterDone = await make("After done", "task", "todo");
    const afterArchived = await make("After archived", "task", "todo", "low");
    const doc = await make("Doc", "doc", null);
    const decided = await make("Decided", "decision", null);
    await storage.createEdge({ from_node: waiting.id, to_node: liveBlocker.id, relation: "blocked_by" });
    await storage.createEdge({ from_node: afterDone.id, to_node: doneBlocker.id, relation: "blocked_by" });
    await storage.createEdge({ from_node: afterArchived.id, to_node: archivedBlocker.id, relation: "blocked_by" });
    ids = { free: free.id, waiting: waiting.id, doneBlocker: doneBlocker.id, archivedBlocker: archivedBlocker.id, liveBlocker: liveBlocker.id, afterDone: afterDone.id, afterArchived: afterArchived.id, doc: doc.id, decided: decided.id };

    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer({
      workspaceId: workspace.id, workspaceRef: slug, scopes: ["nodes:read", "nodes:write"], tokenId: "t", tokenScope: "workspace", subjectUserId: null,
      grant: { workspaceId: workspace.id, principal: { kind: "agent", id: "a" }, verbs: ["read", "write"], reach: { type: "all" } } as never,
      storage,
    });
    client = new Client({ name: "t", version: "0" });
    await server.connect(st); await client.connect(ct);
    close = async () => { await client.close(); await server.close(); };
  });
  afterEach(async () => close());

  it("a saved view with unblocked:true returns the same ids as nodes(op=list, unblocked:true)", async () => {
    const expected = sorted([ids.free!, ids.liveBlocker!, ids.afterDone!, ids.afterArchived!]);

    const listed = body<{ nodes: Array<{ id: string }> }>(await client.callTool({ name: "nodes", arguments: { op: "list", unblocked: true } }));
    expect(sorted(listed.nodes.map((n) => n.id))).toEqual(expected);

    const view = body<{ view: { id: string } }>(await client.callTool({
      name: "views_write",
      arguments: { op: "create", name: "What can I start", query: { schema_version: 1, unblocked: true }, presentation: { schema_version: 1, renderer: "list" } },
    })).view;
    const resolved = body<{ result: { node_ids: string[]; applied_filters: { unblocked: boolean } } }>(
      await client.callTool({ name: "views", arguments: { op: "resolve", id: view.id } }),
    ).result;
    expect(resolved.applied_filters.unblocked).toBe(true);
    expect(resolved.node_ids).toEqual(expected);

    // And the same contract passed inline to list.
    const viaQuery = body<{ nodes: Array<{ id: string }> }>(await client.callTool({ name: "nodes", arguments: { op: "list", query: { schema_version: 1, unblocked: true } } }));
    expect(sorted(viaQuery.nodes.map((n) => n.id))).toEqual(expected);
  });

  it("merges shortcuts with query, and query wins on the keys it names", async () => {
    // kind shortcut + unblocked from the query.
    const merged = body<{ nodes: Array<{ id: string }> }>(await client.callTool({
      name: "nodes", arguments: { op: "list", kind: "task", query: { unblocked: true } },
    }));
    expect(sorted(merged.nodes.map((n) => n.id))).toEqual(sorted([ids.free!, ids.afterDone!, ids.afterArchived!]));

    // The query's kinds override the shortcut's kind.
    const overridden = body<{ nodes: Array<{ id: string; kind: string }> }>(await client.callTool({
      name: "nodes", arguments: { op: "list", kind: "task", query: { kinds: ["bug"] } },
    }));
    expect(overridden.nodes.map((n) => n.id)).toEqual([ids.liveBlocker]);

    // include_archived widens statuses; a query that names statuses wins.
    const all = body<{ nodes: Array<{ id: string }> }>(await client.callTool({ name: "nodes", arguments: { op: "list", include_archived: true } }));
    expect(all.nodes.map((n) => n.id)).toContain(ids.archivedBlocker);
    const only = body<{ nodes: Array<{ id: string }> }>(await client.callTool({
      name: "nodes", arguments: { op: "list", include_archived: true, query: { statuses: ["archived"] } },
    }));
    expect(only.nodes.map((n) => n.id)).toEqual([ids.archivedBlocker]);
  });

  it("rejects a malformed query and says which contract it takes", async () => {
    const res = await client.callTool({ name: "nodes", arguments: { op: "list", query: { kinds: ["spreadsheet"] } } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/invalid query: kinds/);
    expect(text(res)).toMatch(/views\(op=query\)/);
  });
});
