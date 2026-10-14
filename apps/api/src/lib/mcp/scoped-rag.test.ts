import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";

const mocks = vi.hoisted(() => ({ listAuthorizedCapabilityTools: vi.fn() }));
vi.mock("@/lib/capabilities/catalog", () => ({ listAuthorizedCapabilityTools: mocks.listAuthorizedCapabilityTools }));
vi.mock("@/lib/capabilities/gateway", () => ({ CapabilityGatewayError: class extends Error {}, invokeAuthorizedCapability: vi.fn() }));
import { buildMcpServer } from "./server";

function payload(result: Awaited<ReturnType<Client["callTool"]>>) {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  return JSON.parse(first?.text ?? "{}") as Record<string, unknown>;
}

describe("MCP scoped RAG", () => {
  let client: Client;
  let close: () => Promise<void>;
  let ids: { product: string; tech: string };

  beforeEach(async () => {
    mocks.listAuthorizedCapabilityTools.mockResolvedValue([]);
    const workspace = createWorkspace({ name: "Scoped RAG", slug: `scoped-rag-${Date.now()}-${Math.random()}` });
    const storage = resolveDemoStorage(workspace.slug)!;
    const product = await storage.createNode({ title: "Product launch", kind: "doc", parent_id: null, content_md: "launch strategy shared" });
    const tech = await storage.createNode({ title: "Tech launch", kind: "adr", parent_id: null, content_md: "launch architecture shared" });
    ids = { product: product.id, tech: tech.id };
    const pair = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer({ workspaceId: workspace.id, workspaceRef: workspace.slug, scopes: ["nodes:read", "chat:run"], tokenId: "rag-token", tokenScope: "workspace", subjectUserId: null,
    grant: { workspaceId: "ws-1", principal: { kind: "user", id: "u1" }, verbs: ["read","write","delete","tags:create","tags:update","tags:delete","admin"], reach: { type: "all" } } as never, storage });
    client = new Client({ name: "scoped-rag-test", version: "1" });
    await server.connect(pair[1]);
    await client.connect(pair[0]);
    close = async () => { await client.close(); await server.close(); };
  });
  afterEach(async () => close());

  it("keeps workspace as default and applies selection before search", async () => {
    const global = payload(await client.callTool({ name: "nodes", arguments: { op: "search", query: "launch" } }));
    expect((global.scope as { type: string }).type).toBe("workspace");

    const selected = payload(await client.callTool({
      name: "nodes",
      arguments: {
        op: "search",
        query: "launch",
        scope: { schema_version: 1, type: "selection", node_ids: [ids.product] },
      },
    }));
    expect((selected.scope as { size: number }).size).toBe(1);
    expect((selected.hits as Array<{ node_id: string }>).map((hit) => hit.node_id)).toEqual([ids.product]);
  });

  it("prefilters kinds and exposes auto's global lane on ask_rag", async () => {
    const kindResult = payload(await client.callTool({ name: "nodes", arguments: { op: "search", query: "launch", kinds: ["adr"] } }));
    expect((kindResult.hits as Array<{ node_id: string }>).map((hit) => hit.node_id)).toEqual([ids.tech]);

    const ask = payload(await client.callTool({
      name: "ask_rag",
      arguments: {
        query: "launch",
        synthesize: false,
        scope: { schema_version: 1, type: "auto", node_ids: [ids.product] },
      },
    }));
    expect(ask.scope).toMatchObject({ type: "auto", global_lane: true });
    expect((ask.hits as Array<{ node_id: string }>).map((hit) => hit.node_id)).toEqual(expect.arrayContaining([ids.product, ids.tech]));
  });
});
