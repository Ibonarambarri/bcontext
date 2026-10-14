/**
 * Saving what an external tool returned, with the receipt: a node created
 * with `provenance` carries it under data.provenance and links the gateway's
 * invocation to the node. The ledger is Supabase-only; without it the
 * reference is stored as given and the link is reported as not made.
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
import { capabilityProvenanceData, invocationIdFromProvenance } from "@/lib/capabilities/provenance";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
const text = (r: ToolResult) => (r as { content: Array<{ type: string; text?: string }> }).content[0]?.text ?? "";
const body = <T = Record<string, unknown>>(r: ToolResult) => JSON.parse(text(r)) as T;

const INVOCATION = "12345678-1234-4123-8123-123456789012";

describe("capability provenance on nodes_write(op=create)", () => {
  let client: Client;
  let close: () => Promise<void>;
  let storage: Storage;

  beforeEach(async () => {
    mocks.listAuthorizedCapabilityTools.mockReset().mockResolvedValue([]);
    const slug = `mcp-prov-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = createWorkspace({ name: "Provenance", slug });
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

  it("stores the receipt under data.provenance and reports whether the ledger was linked", async () => {
    const res = await client.callTool({
      name: "nodes_write",
      arguments: {
        op: "create",
        kind: "doc",
        title: "GitHub issue 42",
        content_md: "## Summary\n\nWhat the tool returned.",
        provenance: { capability: "issues", tool: "get_issue", invocation_id: INVOCATION },
      },
    });
    expect(res.isError).toBeFalsy();
    const created = body<{ id: string; node: { data: Record<string, unknown> }; invocation_linked: boolean }>(res);
    expect(created.node.data.provenance).toEqual({
      source: "capability",
      capability: "issues",
      tool: "get_issue",
      invocation_id: INVOCATION,
    });
    // No Supabase in tests: the link cannot be made and says so, rather than
    // pretending.
    expect(created.invocation_linked).toBe(false);
    expect((await storage.getNode(created.id))!.data.provenance).toMatchObject({ invocation_id: INVOCATION });
  });

  it("keeps subtasks and provenance side by side in data", async () => {
    const created = body<{ node: { data: Record<string, unknown> }; subtasks: unknown[] }>(
      await client.callTool({
        name: "nodes_write",
        arguments: {
          op: "create",
          kind: "task",
          title: "Follow up on the issue",
          subtasks: [{ title: "Reply", summary: "Answer the reporter" }],
          provenance: { capability: "issues", tool: "get_issue", invocation_id: INVOCATION },
        },
      }),
    );
    expect(created.subtasks).toHaveLength(1);
    expect(created.node.data.provenance).toMatchObject({ source: "capability" });
  });

  it("refuses a receipt that is not an invocation id", async () => {
    const res = await client.callTool({
      name: "nodes_write",
      arguments: { op: "create", kind: "doc", title: "x", provenance: { capability: "issues", tool: "get_issue", invocation_id: "not-a-uuid" } },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/invalid arguments/);
  });

  it("derives the same shape for an ingest candidate stamped with an invocation id", () => {
    // Manual and automatic ingest converge: an ingest candidate whose
    // connector left `invocation_id` in its provenance materialises with the
    // same data.provenance a manual create would write.
    expect(invocationIdFromProvenance({ invocation_id: INVOCATION })).toBe(INVOCATION);
    expect(invocationIdFromProvenance({ invocation_id: "nope" })).toBeNull();
    expect(invocationIdFromProvenance({ source: "github" })).toBeNull();
    expect(invocationIdFromProvenance(null)).toBeNull();
    expect(capabilityProvenanceData({ capability: "issues", tool: "list", invocation_id: INVOCATION })).toEqual({
      source: "capability", capability: "issues", tool: "list", invocation_id: INVOCATION,
    });
  });
});
