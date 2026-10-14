/**
 * Writing by block over MCP: nodes_write(op=append) and op=replace_block
 * touch one H2 section, so two agents editing different sections of the same
 * node both land, and a pinned if_updated_at stays strict.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { ConflictError, type Storage } from "@/lib/storage";
import { list as listActivity } from "@/lib/activity";

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

interface BlockResult {
  id: string;
  block: { block_id: string; heading: string | null; body_md: string };
  blocks: string[];
  updated_at: string;
  rebased?: boolean;
}

const DOC = "## Goal\n\nShip it.\n\n## Notes\n\n- [ ] one\n";

describe("nodes_write by block", () => {
  let client: Client;
  let close: () => Promise<void>;
  let storage: Storage;
  let slug: string;

  beforeEach(async () => {
    mocks.listAuthorizedCapabilityTools.mockReset().mockResolvedValue([]);
    slug = `mcp-blocks-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = createWorkspace({ name: "Blocks", slug });
    storage = resolveDemoStorage(slug)!;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer({
      workspaceId: workspace.id, workspaceRef: slug, scopes: ["nodes:read", "nodes:write"], tokenId: "t", tokenScope: "workspace", subjectUserId: null,
      agentId: "agent-1", agentLabel: "Builder",
      grant: { workspaceId: workspace.id, principal: { kind: "agent", id: "agent-1" }, verbs: ["read", "write"], reach: { type: "all" } } as never,
      storage,
    });
    client = new Client({ name: "t", version: "0" });
    await server.connect(st); await client.connect(ct);
    close = async () => { await client.close(); await server.close(); };
  });
  afterEach(async () => close());

  async function createDoc(): Promise<string> {
    const node = await storage.createNode({ kind: "task", title: "Ship blocks", content_md: DOC, parent_id: null, status: "todo" });
    return node.id;
  }

  it("appends a block and reports the block ids", async () => {
    const id = await createDoc();
    const res = await client.callTool({ name: "nodes_write", arguments: { op: "append", node_id: id, heading: "Result", body_md: "Shipped in PR 1." } });
    expect(res.isError).toBeFalsy();
    const out = body<BlockResult>(res);
    expect(out.block).toEqual({ block_id: "result", heading: "Result", body_md: "Shipped in PR 1." });
    expect(out.blocks).toEqual(["goal", "notes", "result"]);
    const node = (await storage.getNode(id))!;
    expect(node.content_md).toBe(`${DOC}\n## Result\n\nShipped in PR 1.\n`);
    expect(node.updated_at).toBe(out.updated_at);
    // Recorded like every other write: the agent, the block, via mcp.
    const entry = listActivity(slug, 1)[0]!;
    expect(entry.node_id).toBe(id);
    expect(entry.block_id).toBe("result");
    expect(entry.actor.name).toBe("Builder");
  });

  it("replaces one block, renames it on request, and accepts `id` for the node", async () => {
    const id = await createDoc();
    const replaced = body<BlockResult>(await client.callTool({
      name: "nodes_write", arguments: { op: "replace_block", id, block_id: "goal", body_md: "Ship it twice." },
    }));
    expect(replaced.block.body_md).toBe("Ship it twice.");
    expect((await storage.getNode(id))!.content_md).toBe("## Goal\n\nShip it twice.\n\n## Notes\n\n- [ ] one\n");

    const renamed = body<BlockResult>(await client.callTool({
      name: "nodes_write", arguments: { op: "replace_block", node_id: id, block_id: "#notes", body_md: "- [x] one", heading: "Checklist" },
    }));
    expect(renamed.block.block_id).toBe("checklist");
    expect(renamed.blocks).toEqual(["goal", "checklist"]);
    // The old id survives as a redirect for inbound references.
    expect((await storage.getNode(id))!.data.previous_block_ids).toContain("notes");
  });

  it("names the existing blocks when the id is unknown or the heading is taken", async () => {
    const id = await createDoc();
    const missing = await client.callTool({ name: "nodes_write", arguments: { op: "replace_block", node_id: id, block_id: "result", body_md: "x" } });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/#goal, #notes/);
    const taken = await client.callTool({ name: "nodes_write", arguments: { op: "append", node_id: id, heading: "Notes", body_md: "x" } });
    expect(taken.isError).toBe(true);
    expect(text(taken)).toMatch(/replace_block/);
  });

  it("lets two agents land edits on different blocks: the loser of the race is re-applied onto the fresh body", async () => {
    const id = await createDoc();
    // Agent A reads, then agent B rewrites #notes before A's write reaches
    // storage. Simulated by making A's first updateNode lose the race.
    const original = storage.updateNode.bind(storage);
    let raced = false;
    const spy = vi.spyOn(storage, "updateNode").mockImplementation(async (nodeId, patch, opts) => {
      if (!raced) {
        raced = true;
        await original(nodeId, { content_md: "## Goal\n\nShip it.\n\n## Notes\n\n- [x] one\n" });
        const now = (await storage.getNode(nodeId))!;
        throw new ConflictError(nodeId, now.updated_at, opts?.ifUpdatedAt ?? "");
      }
      return original(nodeId, patch, opts);
    });
    const res = await client.callTool({ name: "nodes_write", arguments: { op: "replace_block", node_id: id, block_id: "goal", body_md: "Ship it twice." } });
    spy.mockRestore();
    expect(res.isError).toBeFalsy();
    expect(body<BlockResult>(res).rebased).toBe(true);
    // Both edits are in the body.
    expect((await storage.getNode(id))!.content_md).toBe("## Goal\n\nShip it twice.\n\n## Notes\n\n- [x] one\n");
  });

  it("conflicts only when the other writer touched the SAME block", async () => {
    const id = await createDoc();
    const original = storage.updateNode.bind(storage);
    let raced = false;
    const spy = vi.spyOn(storage, "updateNode").mockImplementation(async (nodeId, patch, opts) => {
      if (!raced) {
        raced = true;
        await original(nodeId, { content_md: "## Goal\n\nSomeone else's goal.\n\n## Notes\n\n- [ ] one\n" });
        const now = (await storage.getNode(nodeId))!;
        throw new ConflictError(nodeId, now.updated_at, opts?.ifUpdatedAt ?? "");
      }
      return original(nodeId, patch, opts);
    });
    const res = await client.callTool({ name: "nodes_write", arguments: { op: "replace_block", node_id: id, block_id: "goal", body_md: "Ship it twice." } });
    spy.mockRestore();
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/409 conflict: block #goal/);
    expect((await storage.getNode(id))!.content_md).toContain("Someone else's goal.");
  });

  it("honours a pinned if_updated_at strictly", async () => {
    const id = await createDoc();
    const stale = (await storage.getNode(id))!.updated_at;
    await new Promise((r) => setTimeout(r, 2));
    await storage.updateNode(id, { title: "Ship blocks (renamed)" });
    const pinned = await client.callTool({ name: "nodes_write", arguments: { op: "append", node_id: id, heading: "Result", body_md: "x", if_updated_at: stale } });
    expect(pinned.isError).toBe(true);
    expect(text(pinned)).toMatch(/409 conflict/);
    const fresh = await client.callTool({ name: "nodes_write", arguments: { op: "append", node_id: id, heading: "Result", body_md: "x" } });
    expect(fresh.isError).toBeFalsy();
  });
});
