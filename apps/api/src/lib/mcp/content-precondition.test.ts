/**
 * A content_md patch over MCP without if_updated_at is refused.
 *
 * The agent lab produced the failure this prevents: a builder's update
 * replaced a reviewer's notes and a planner's sign-off that had landed on the
 * same node minutes earlier, and nothing in the response said so. The
 * timestamp was "strongly recommended"; a recommendation is not a guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";

const mocks = vi.hoisted(() => ({ listAuthorizedCapabilityTools: vi.fn() }));
vi.mock("@/lib/capabilities/catalog", () => ({ listAuthorizedCapabilityTools: mocks.listAuthorizedCapabilityTools }));
vi.mock("@/lib/capabilities/gateway", () => ({ CapabilityGatewayError: class extends Error {}, invokeAuthorizedCapability: vi.fn() }));

import { buildMcpServer } from "./server";

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result as { content: Array<{ type: string; text?: string }> }).content[0]?.text ?? "";
}

describe("nodes_write(op=update) and content_md", () => {
  let client: Client;
  let close: () => Promise<void>;
  let nodeId: string;
  let updatedAt: string;

  beforeEach(async () => {
    mocks.listAuthorizedCapabilityTools.mockReset().mockResolvedValue([]);
    const slug = `mcp-pre-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = createWorkspace({ name: "Precondition", slug });
    const storage = resolveDemoStorage(slug)!;
    const node = await storage.createNode({ kind: "doc", title: "Shared", content_md: "## A\n\nfirst", parent_id: null });
    nodeId = node.id; updatedAt = node.updated_at;
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

  it("refuses a body rewrite without the precondition, and names the current timestamp", async () => {
    const res = await client.callTool({ name: "nodes_write", arguments: { op: "update", id: nodeId, patch: { content_md: "## A\n\nsecond" } } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/precondition_required/);
    expect(text(res)).toContain(updatedAt);
  });

  it("accepts it with the precondition", async () => {
    const res = await client.callTool({ name: "nodes_write", arguments: { op: "update", id: nodeId, patch: { content_md: "## A\n\nsecond" }, if_updated_at: updatedAt } });
    expect(res.isError).toBeFalsy();
  });

  it("leaves metadata-only patches unconstrained", async () => {
    const res = await client.callTool({ name: "nodes_write", arguments: { op: "update", id: nodeId, patch: { title: "Renamed" } } });
    expect(res.isError).toBeFalsy();
  });
});
