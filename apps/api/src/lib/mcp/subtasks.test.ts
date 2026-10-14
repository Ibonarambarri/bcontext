/**
 * Subtasks over MCP: a task created with its steps in one call, read back
 * in full by nodes(op=get), and edited one step at a time by
 * subtasks_write — never by rewriting the task.
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

interface Card { id: string; title: string; summary: string; done: boolean }

describe("subtasks over MCP", () => {
  let client: Client;
  let close: () => Promise<void>;
  let storage: Storage;

  beforeEach(async () => {
    mocks.listAuthorizedCapabilityTools.mockReset().mockResolvedValue([]);
    const slug = `mcp-sub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = createWorkspace({ name: "Subtasks", slug });
    storage = resolveDemoStorage(slug)!;
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

  async function createTask(): Promise<{ id: string; cards: Card[] }> {
    const res = await client.callTool({
      name: "nodes_write",
      arguments: {
        op: "create",
        kind: "task",
        title: "Ship subtasks",
        content_md: "## Goal\n\nOne task, several steps.",
        subtasks: [
          { title: "Contract", summary: "Types + pure helpers", content_md: "## Steps\n\n- schema\n- tests" },
          { title: "MCP", summary: "Two tools", content_md: "subtasks + subtasks_write" },
          { title: "Web", summary: "Cards in the panel" },
        ],
      },
    });
    expect(res.isError).toBeFalsy();
    const created = body<{ id: string; subtasks: Card[]; subtasks_progress: { done: number; total: number } }>(res);
    expect(created.subtasks_progress).toEqual({ done: 0, total: 3 });
    return { id: created.id, cards: created.subtasks };
  }

  it("creates the task with its steps in one call and returns them in full on get", async () => {
    const { id, cards } = await createTask();
    expect(cards.map((c) => c.title)).toEqual(["Contract", "MCP", "Web"]);

    const got = body<{ node: { data: Record<string, unknown> }; subtasks: Array<Card & { content_md: string }>; subtasks_progress: unknown }>(
      await client.callTool({ name: "nodes", arguments: { op: "get", id } }),
    );
    expect(got.subtasks).toHaveLength(3);
    expect(got.subtasks[0]).toMatchObject({ title: "Contract", content_md: "## Steps\n\n- schema\n- tests", done: false });
    // Once, at the top level — not again inside node.data.
    expect(got.node.data).not.toHaveProperty("subtasks");
    expect(got.subtasks_progress).toEqual({ done: 0, total: 3 });
  });

  it("refuses steps on a kind that carries no work", async () => {
    const res = await client.callTool({
      name: "nodes_write",
      arguments: { op: "create", kind: "doc", title: "Notes", subtasks: [{ title: "x" }] },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/task or bug/);
  });

  it("lists cards and gets one with its body", async () => {
    const { id, cards } = await createTask();
    const list = body<{ progress: unknown; subtasks: Card[] }>(await client.callTool({ name: "subtasks", arguments: { op: "list", node_id: id } }));
    expect(list.subtasks.map((c) => c.title)).toEqual(["Contract", "MCP", "Web"]);
    expect(list.subtasks[0]).not.toHaveProperty("content_md");
    const one = body<{ subtask: { content_md: string } }>(await client.callTool({ name: "subtasks", arguments: { op: "get", node_id: id, id: cards[1]!.id } }));
    expect(one.subtask.content_md).toBe("subtasks + subtasks_write");
    const missing = await client.callTool({ name: "subtasks", arguments: { op: "get", node_id: id, id: "nope" } });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain(cards[0]!.id);
  });

  it("toggles, edits, adds, reorders and deletes one step without touching the body", async () => {
    const { id, cards } = await createTask();
    const bodyBefore = (await storage.getNode(id))!.content_md;

    const toggled = body<{ changed: boolean; subtask: Card; progress: { done: number } }>(
      await client.callTool({ name: "subtasks_write", arguments: { op: "toggle", node_id: id, id: cards[0]!.id } }),
    );
    expect(toggled.subtask.done).toBe(true);
    expect(toggled.progress.done).toBe(1);
    const again = body<{ changed: boolean }>(
      await client.callTool({ name: "subtasks_write", arguments: { op: "toggle", node_id: id, id: cards[0]!.id, done: true } }),
    );
    expect(again.changed).toBe(false);

    const edited = body<{ subtask: { summary: string; content_md: string } }>(
      await client.callTool({ name: "subtasks_write", arguments: { op: "update", node_id: id, id: cards[1]!.id, patch: { summary: "Two tools, flat schema" } } }),
    );
    expect(edited.subtask).toMatchObject({ summary: "Two tools, flat schema", content_md: "subtasks + subtasks_write" });

    const added = body<{ subtask: Card; order: string[] }>(
      await client.callTool({ name: "subtasks_write", arguments: { op: "add", node_id: id, title: "Docs", summary: "llms.txt", position: 0 } }),
    );
    expect(added.order[0]).toBe(added.subtask.id);
    expect(added.order).toHaveLength(4);

    const moved = body<{ order: string[] }>(
      await client.callTool({ name: "subtasks_write", arguments: { op: "reorder", node_id: id, id: added.subtask.id, position: 3 } }),
    );
    expect(moved.order[3]).toBe(added.subtask.id);

    const reordered = body<{ order: string[] }>(
      await client.callTool({ name: "subtasks_write", arguments: { op: "reorder", node_id: id, ids: [...moved.order].reverse() } }),
    );
    expect(reordered.order[0]).toBe(added.subtask.id);

    const deleted = body<{ order: string[]; subtask: null }>(
      await client.callTool({ name: "subtasks_write", arguments: { op: "delete", node_id: id, id: added.subtask.id } }),
    );
    expect(deleted.subtask).toBeNull();
    expect(deleted.order).toHaveLength(3);

    expect((await storage.getNode(id))!.content_md).toBe(bodyBefore);
  });

  it("names the missing field when an op is called with the wrong shape", async () => {
    const { id } = await createTask();
    const res = await client.callTool({ name: "subtasks_write", arguments: { op: "add", node_id: id } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/invalid arguments for op=add: title/);
    const res2 = await client.callTool({ name: "subtasks_write", arguments: { op: "toggle", node_id: id } });
    expect(text(res2)).toMatch(/op=toggle: id/);
  });

  it("honours a pinned if_updated_at strictly and retries when it is not pinned", async () => {
    const { id, cards } = await createTask();
    const stale = (await storage.getNode(id))!.updated_at;
    // Someone else edits the title in between.
    await new Promise((r) => setTimeout(r, 2));
    await storage.updateNode(id, { title: "Ship subtasks (renamed)" });

    const pinned = await client.callTool({ name: "subtasks_write", arguments: { op: "toggle", node_id: id, id: cards[0]!.id, if_updated_at: stale } });
    expect(pinned.isError).toBe(true);
    expect(text(pinned)).toMatch(/409 conflict/);

    const unpinned = await client.callTool({ name: "subtasks_write", arguments: { op: "toggle", node_id: id, id: cards[0]!.id } });
    expect(unpinned.isError).toBeFalsy();
    const node = (await storage.getNode(id))!;
    // The other writer's change survived the subtask write.
    expect(node.title).toBe("Ship subtasks (renamed)");
  });

  it("refuses subtasks on a doc, and points at checklist items instead", async () => {
    const doc = await storage.createNode({ kind: "doc", title: "Doc", content_md: "", parent_id: null });
    const res = await client.callTool({ name: "subtasks_write", arguments: { op: "add", node_id: doc.id, title: "x" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/- \[ \]/);
  });
});
