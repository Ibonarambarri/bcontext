import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { resetDemoViewsForTests } from "@/lib/views/store";

const mocks = vi.hoisted(() => ({ listAuthorizedCapabilityTools: vi.fn() }));
vi.mock("@/lib/capabilities/catalog", () => ({ listAuthorizedCapabilityTools: mocks.listAuthorizedCapabilityTools }));
vi.mock("@/lib/capabilities/gateway", () => ({ CapabilityGatewayError: class extends Error {}, invokeAuthorizedCapability: vi.fn() }));
import { buildMcpServer } from "./server";

function payload(result: Awaited<ReturnType<Client["callTool"]>>) {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  return JSON.parse(first?.text ?? "{}") as Record<string, unknown>;
}

describe("MCP saved views", () => {
  let client: Client;
  let close: () => Promise<void>;
  let storage: NonNullable<ReturnType<typeof resolveDemoStorage>>;
  beforeEach(async () => {
    resetDemoViewsForTests(); mocks.listAuthorizedCapabilityTools.mockResolvedValue([]);
    const workspace = createWorkspace({ name: "MCP views", slug: `mcp-views-${Date.now()}-${Math.random()}` });
    storage = resolveDemoStorage(workspace.slug)!;
    const pair = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer({ workspaceId: workspace.id, workspaceRef: workspace.slug, scopes: ["nodes:read", "nodes:write"], tokenId: "view-token", tokenScope: "workspace", subjectUserId: null,
    grant: { workspaceId: "ws-1", principal: { kind: "user", id: "u1" }, verbs: ["read","write","delete","tags:create","tags:update","tags:delete","admin"], reach: { type: "all" } } as never, storage });
    client = new Client({ name: "views-test", version: "1" });
    await server.connect(pair[1]); await client.connect(pair[0]);
    close = async () => { await client.close(); await server.close(); };
  });
  afterEach(async () => close());

  it("advertises and executes the full CRUD and resolver contract", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    // Eight tools became two, split by risk so each can carry an honest
    // annotation: a client that auto-approves reads cannot do so if `get` and
    // `delete` share a tool.
    expect(names).toEqual(expect.arrayContaining(["views", "views_write"]));
    const listed = payload(await client.callTool({ name: "views", arguments: { op: "list" } })).views as unknown[];
    expect(listed).toHaveLength(8);
    const created = payload(await client.callTool({ name: "views_write", arguments: { op: "create", name: "MCP tasks", query: { schema_version: 1, kinds: ["task"] }, presentation: { schema_version: 1, renderer: "list" } } })).view as { id: string; version: number };
    const copy = payload(await client.callTool({ name: "views_write", arguments: { op: "duplicate", id: created.id } })).view as { id: string };
    expect(copy.id).not.toBe(created.id);
    const resolved = payload(await client.callTool({ name: "views", arguments: { op: "resolve", id: created.id } })).result as { node_ids: string[]; applied_filters: { kinds: string[] } };
    expect(resolved.applied_filters.kinds).toEqual(["task"]);
    const update = await client.callTool({ name: "views_write", arguments: { op: "update", id: created.id, expected_version: 1, patch: { name: "Updated" } } });
    expect(update.isError).not.toBe(true);
    const conflict = await client.callTool({ name: "views_write", arguments: { op: "update", id: created.id, expected_version: 1, patch: { name: "Stale" } } });
    expect(conflict.isError).toBe(true);
    const deleted = await client.callTool({ name: "views_write", arguments: { op: "delete", id: copy.id, expected_version: 1 } });
    expect(deleted.isError).not.toBe(true);
  });

  it("views(op=query) and views(op=resolve) inherit tag filters through the tag hierarchy", async () => {
    // Both tools share resolveViewQuery, so hierarchy expansion arrives for
    // free — this test pins that contract. parent tag "Platform" <- "API".
    const parent = await storage.createTag({ name: "Platform" });
    const childTag = await storage.createTag({ name: "API" });
    await storage.createTagRelations(childTag.id, { parent_ids: [parent.id] });
    const tagged = await storage.createNode({ title: "Gateway", kind: "doc", parent_id: null, tag_ids: [childTag.id] });
    await storage.createNode({ title: "Untagged", kind: "doc", parent_id: null });

    const query = { schema_version: 1, tags_any: ["platform"] };
    const resolved = payload(await client.callTool({ name: "views", arguments: { op: "query", query } })).result as { node_ids: string[] };
    expect(resolved.node_ids).toEqual([tagged.id]);

    const view = payload(await client.callTool({ name: "views_write", arguments: { op: "create", name: "Platform view", query, presentation: { schema_version: 1, renderer: "list" } } })).view as { id: string };
    const viaView = payload(await client.callTool({ name: "views", arguments: { op: "resolve", id: view.id } })).result as { node_ids: string[] };
    expect(viaView.node_ids).toEqual([tagged.id]);

    // list_nodes goes through the storage tag filter — same inheritance.
    const listed = payload(await client.callTool({ name: "nodes", arguments: { op: "list", tag_ids: [parent.id] } })).nodes as Array<{ id: string }>;
    expect(listed.map((node) => node.id)).toEqual([tagged.id]);
  });
});
