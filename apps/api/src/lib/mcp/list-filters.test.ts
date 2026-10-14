/**
 * `nodes(op=list)` filters kind, status and parent_id in memory. The limit has
 * to be applied after that, not sent to the database with it.
 *
 * It was sent with it, and the failure was invisible in the way that matters:
 * asking for 25 tasks truncated the workspace to 25 nodes of any kind and then
 * kept the tasks among them. In a real workspace that returned exactly one task
 * out of seventeen, with no error, no warning and a plausible-looking
 * shape — so the documented start-of-session flow
 * (`list({ kind: "task", unblocked: true })`) showed an almost empty queue and
 * nobody suspected the tool.
 *
 * A filter that silently returns a subset is worse than one that fails, because
 * the caller acts on it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";

const mocks = vi.hoisted(() => ({ listAuthorizedCapabilityTools: vi.fn() }));
vi.mock("@/lib/capabilities/catalog", () => ({
  listAuthorizedCapabilityTools: mocks.listAuthorizedCapabilityTools,
}));
vi.mock("@/lib/capabilities/gateway", () => ({
  CapabilityGatewayError: class CapabilityGatewayError extends Error {},
  invokeAuthorizedCapability: vi.fn(),
}));

import { buildMcpServer } from "./server";

function payload(result: Awaited<ReturnType<Client["callTool"]>>) {
  const first = (result as { content: Array<{ type: string; text?: string }> }).content[0];
  if (!first || first.type !== "text") throw new Error("missing text result");
  return JSON.parse(first.text ?? "{}") as {
    nodes: Array<{ id: string; kind: string; status: string | null; title: string }>;
    matched?: number;
    truncated?: boolean;
  };
}

describe("nodes(op=list) filters", () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    mocks.listAuthorizedCapabilityTools.mockReset().mockResolvedValue([]);
    const slug = `mcp-list-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = createWorkspace({ name: "MCP list", slug });
    const storage = resolveDemoStorage(slug);
    if (!storage) throw new Error("demo storage missing");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer({
      workspaceId: workspace.id,
      workspaceRef: slug,
      scopes: ["nodes:read", "nodes:write", "admin:*"],
      tokenId: "demo-token",
      tokenScope: "workspace",
      subjectUserId: null,
      grant: {
        workspaceId: workspace.id,
        principal: { kind: "user", id: "u1" },
        verbs: ["read", "write", "delete", "admin"],
        reach: { type: "all" },
      } as never,
      storage,
    });
    client = new Client({ name: "list-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close = async () => {
      await client.close();
      await server.close();
    };

    // The shape that broke it: many docs, few tasks, tasks created last so any
    // truncation of the raw listing loses them.
    for (let i = 0; i < 40; i++) {
      await client.callTool({
        name: "nodes_write",
        arguments: { op: "create", title: `Doc ${i}`, kind: "doc" },
      });
    }
    for (const [i, status] of ["todo", "todo", "done", "in_progress"].entries()) {
      await client.callTool({
        name: "nodes_write",
        arguments: { op: "create", title: `Task ${i}`, kind: "task", status },
      });
    }
  });

  afterEach(async () => close());

  it("returns every task, not the tasks that survived a truncated page", async () => {
    const result = payload(
      await client.callTool({ name: "nodes", arguments: { op: "list", kind: "task", limit: 25 } }),
    );
    expect(result.nodes).toHaveLength(4);
    expect(result.nodes.every((n) => n.kind === "task")).toBe(true);
  });

  it("applies status the same way", async () => {
    const result = payload(
      await client.callTool({
        name: "nodes",
        arguments: { op: "list", kind: "task", status: "todo", limit: 25 },
      }),
    );
    expect(result.nodes).toHaveLength(2);
  });

  it("leaves archived nodes out unless asked, and never counts them as unblocked", async () => {
    await client.callTool({ name: "nodes_write", arguments: { op: "create", title: "Shelved", kind: "task", status: "archived" } });
    const listed = payload(await client.callTool({ name: "nodes", arguments: { op: "list", kind: "task", limit: 25 } }));
    expect(listed.nodes.map((n) => n.title)).not.toContain("Shelved");
    const asked = payload(await client.callTool({ name: "nodes", arguments: { op: "list", status: "archived", limit: 25 } }));
    expect(asked.nodes.map((n) => n.title)).toEqual(["Shelved"]);
    const included = payload(await client.callTool({ name: "nodes", arguments: { op: "list", kind: "task", include_archived: true, limit: 25 } }));
    expect(included.nodes).toHaveLength(5);
    const ready = payload(await client.callTool({ name: "nodes", arguments: { op: "list", unblocked: true, limit: 25 } }));
    expect(ready.nodes.map((n) => n.title)).not.toContain("Shelved");
  });

  it("says so when it does cut the list short", async () => {
    // Truncation is legitimate; hiding it is not. `matched` is what tells a
    // caller the answer is a page rather than the set.
    const result = payload(
      await client.callTool({ name: "nodes", arguments: { op: "list", kind: "doc", limit: 10 } }),
    );
    expect(result.nodes).toHaveLength(10);
    expect(result.matched).toBe(40);
    expect(result.truncated).toBe(true);
  });

  it("does not claim truncation when the whole set fits", async () => {
    const result = payload(
      await client.callTool({ name: "nodes", arguments: { op: "list", kind: "task", limit: 25 } }),
    );
    expect(result.matched).toBe(4);
    expect(result.truncated).toBe(false);
  });
});
