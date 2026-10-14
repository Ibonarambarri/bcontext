/**
 * Capabilities over the MCP: an admin principal lists the catalog, connects
 * a provider, grants itself the tools and finds them with capability_search;
 * a principal without the admin verb is never shown the admin tools and is
 * refused if it calls them anyway. tools/list itself never changes with a
 * grant — that is what the search is for.
 *
 * The catalog itself is a database; here it is a tiny in-memory fake behind
 * the same module boundary the server calls, so what is under test is the
 * server's wiring — verb gate, op routing, and search reflecting grants.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import type { AuthorizedCapabilityTool } from "@/lib/capabilities/types";
import type { Verb } from "@/lib/auth/grants";

interface FakeCapability { id: string; key: string; provider: string; title: string; status: string; tools: string[] }
interface FakeGrant { id: string; capability_id: string; principal: string; allowed_tools?: string[]; revoked: boolean }

const fake = vi.hoisted(() => ({
  capabilities: [] as FakeCapability[],
  grants: [] as FakeGrant[],
  attempts: new Map<string, { status: string }>(),
  seq: 0,
  reset() { this.capabilities = []; this.grants = []; this.attempts = new Map(); this.seq = 0; },
  uuid() { this.seq += 1; return `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`; },
}));

vi.mock("@/lib/capabilities/mcp-admin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/capabilities/mcp-admin")>("@/lib/capabilities/mcp-admin");
  const self = (actor: { agentId?: string; tokenId: string }) => actor.agentId ?? actor.tokenId;
  return {
    ...actual,
    listCapabilities: vi.fn(async (actor, input) => ({
      capabilities: fake.capabilities
        .filter((c) => !input.q || c.title.includes(input.q))
        .map((c) => ({
          ...c,
          granted_to_me: fake.grants.some((g) => g.capability_id === c.id && g.principal === self(actor) && !g.revoked),
        })),
    })),
    discoverCapability: vi.fn(async (_actor, input) => ({
      provider: { name: new URL(input.endpoint_url).hostname.split(".")[0], title: "Fake", description: "" },
      tools: [{ name: "search" }, { name: "create_issue" }],
      truncated: false,
      logo_url: null,
    })),
    capabilityStatus: vi.fn(async (_actor, input) => {
      if (input.attempt_id) {
        const attempt = fake.attempts.get(input.attempt_id);
        if (!attempt) throw new actual.CapabilityAdminError("oauth_attempt_not_found", "OAuth attempt was not found");
        return { attempt: { id: input.attempt_id, status: attempt.status } };
      }
      const capability = fake.capabilities.find((c) => c.id === input.capability_id);
      if (!capability) throw new actual.CapabilityAdminError("capability_not_found", "capability not found in this workspace");
      return { capability: { ...capability, grants: fake.grants.filter((g) => g.capability_id === capability.id && !g.revoked) } };
    }),
    connectCapability: vi.fn(async (_actor, input) => {
      if (input.auth.type === "oauth" && !input.auth.attempt_id) {
        const id = fake.uuid();
        fake.attempts.set(id, { status: "pending" });
        return { status: "authorization_required", attempt_id: id, authorization_url: `https://auth.example.com/consent?attempt=${id}` };
      }
      if (input.auth.type === "oauth" && fake.attempts.get(input.auth.attempt_id!)?.status !== "authorized") {
        throw new actual.CapabilityAdminError("oauth_attempt_not_authorized", "OAuth authorization is not complete");
      }
      if (fake.capabilities.some((c) => c.key === input.key)) {
        throw new actual.CapabilityAdminError("capability_exists", `a capability with key "${input.key}" already exists`);
      }
      const capability: FakeCapability = {
        id: fake.uuid(),
        key: input.key,
        provider: input.provider ?? new URL(input.endpoint_url).hostname.split(".")[0]!,
        title: input.title ?? "Fake",
        status: input.status,
        tools: input.tools ?? ["search", "create_issue"],
      };
      fake.capabilities.push(capability);
      return { status: "connected", capability, tools: capability.tools };
    }),
    disconnectCapability: vi.fn(async (_actor, input) => {
      const idx = fake.capabilities.findIndex((c) => c.id === input.capability_id);
      if (idx < 0) throw new actual.CapabilityAdminError("capability_not_found", "capability not found in this workspace");
      fake.capabilities.splice(idx, 1);
      let revoked = 0;
      for (const g of fake.grants) if (g.capability_id === input.capability_id && !g.revoked) { g.revoked = true; revoked++; }
      return { ok: true, capability_id: input.capability_id, grants_revoked: revoked, already_removed: false };
    }),
    grantCapability: vi.fn(async (actor, input) => {
      if (!fake.capabilities.some((c) => c.id === input.capability_id)) {
        throw new actual.CapabilityAdminError("capability_not_found", "capability not found in this workspace");
      }
      const grant: FakeGrant = { id: fake.uuid(), capability_id: input.capability_id, principal: input.principal?.id ?? self(actor), allowed_tools: input.allowed_tools, revoked: false };
      fake.grants.push(grant);
      return { grant };
    }),
    revokeCapabilityGrant: vi.fn(async (_actor, input) => {
      const grant = fake.grants.find((g) => g.id === input.grant_id && !g.revoked);
      if (grant) grant.revoked = true;
      return { ok: true, revoked: Boolean(grant), grant_id: input.grant_id };
    }),
  };
});

// What the catalog resolves for a principal, derived from the fake grants —
// the same (provider, key, tool) namespace the real one uses.
vi.mock("@/lib/capabilities/catalog", async () => {
  const actual = await vi.importActual<typeof import("@/lib/capabilities/catalog")>("@/lib/capabilities/catalog");
  return {
    ...actual,
    listAuthorizedCapabilityTools: vi.fn(async (actor: { agentId?: string; tokenId: string }): Promise<AuthorizedCapabilityTool[]> => {
      const me = actor.agentId ?? actor.tokenId;
      const out: AuthorizedCapabilityTool[] = [];
      for (const grant of fake.grants) {
        if (grant.revoked || grant.principal !== me) continue;
        const capability = fake.capabilities.find((c) => c.id === grant.capability_id);
        if (!capability || capability.status !== "approved") continue;
        for (const tool of capability.tools) {
          if (grant.allowed_tools && !grant.allowed_tools.includes(tool)) continue;
          out.push({
            workspaceId: "ws",
            ref: actual.capabilityRef(capability.provider, capability.key, tool),
            remoteName: tool,
            description: `${tool} on ${capability.provider}`,
            capabilityTitle: capability.title,
            inputSchema: { type: "object", properties: {}, additionalProperties: true },
            capabilityId: capability.id,
            capabilityVersionId: "v1",
            capabilityKey: capability.key,
            capabilityType: "mcp_server",
            provider: capability.provider,
            principalId: me,
            contract: { protocol: "mcp_streamable_http", tools: [{ name: tool, description: "", inputSchema: { type: "object" } }] },
            connection: { id: "c", endpointUrl: "https://mcp.example.com/mcp", authType: "none", authHeaderName: null, secretRef: null, allowedHosts: ["mcp.example.com"], timeoutMs: 5000 },
            constraints: {},
          });
        }
      }
      return out;
    }),
  };
});
vi.mock("@/lib/capabilities/gateway", () => ({
  CapabilityGatewayError: class extends Error {},
  invokeAuthorizedCapability: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
}));

import { buildMcpServer } from "./server";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
const text = (r: ToolResult) => (r as { content: Array<{ type: string; text?: string }> }).content[0]?.text ?? "";
const body = <T = Record<string, unknown>>(r: ToolResult) => JSON.parse(text(r)) as T;

async function connect(verbs: Verb[], agentId: string) {
  const slug = `mcp-cap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workspace = createWorkspace({ name: "Capabilities", slug });
  const storage = resolveDemoStorage(slug)!;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer({
    workspaceId: workspace.id,
    workspaceRef: slug,
    scopes: ["nodes:read", "nodes:write", "admin:*"],
    tokenId: `tok-${agentId}`,
    tokenScope: "workspace",
    agentId,
    agentLabel: "Test agent",
    subjectUserId: "user-1",
    grant: { workspaceId: workspace.id, principal: { kind: "agent", id: agentId }, verbs, reach: { type: "all" } },
    storage,
  });
  const client = new Client({ name: "t", version: "0" });
  await server.connect(st);
  await client.connect(ct);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

describe("capabilities over MCP", () => {
  let admin: Awaited<ReturnType<typeof connect>>;
  let editor: Awaited<ReturnType<typeof connect>>;

  beforeEach(async () => {
    fake.reset();
    admin = await connect(["read", "write", "delete", "admin"], "agent-admin");
    editor = await connect(["read", "write", "delete"], "agent-editor");
  });
  afterEach(async () => { await admin.close(); await editor.close(); });

  /** What capability_search finds for this principal, as refs. */
  async function searchRefs(client: Client, query = "*"): Promise<string[]> {
    const res = await client.callTool({ name: "capability_search", arguments: { query } });
    expect(res.isError, text(res)).toBeFalsy();
    return body<{ hits: Array<{ ref: string }> }>(res).hits.map((hit) => hit.ref);
  }

  it("shows the capability tools to admins only, and refuses the editor that guesses the name", async () => {
    const adminNames = (await admin.client.listTools()).tools.map((t) => t.name);
    expect(adminNames).toContain("capabilities");
    expect(adminNames).toContain("capabilities_write");
    const editorNames = (await editor.client.listTools()).tools.map((t) => t.name);
    expect(editorNames).not.toContain("capabilities");
    expect(editorNames).not.toContain("capabilities_write");

    const refused = await editor.client.callTool({ name: "capabilities", arguments: { op: "list" } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/"admin" permission/);
    const refusedWrite = await editor.client.callTool({
      name: "capabilities_write",
      arguments: { op: "connect", key: "gh", endpoint_url: "https://mcp.example.com/mcp" },
    });
    expect(refusedWrite.isError).toBe(true);
    expect(fake.capabilities).toHaveLength(0);
  });

  it("lists, discovers, connects, grants itself, and finds the tools with capability_search", async () => {
    expect(body<{ capabilities: unknown[] }>(await admin.client.callTool({ name: "capabilities", arguments: { op: "list" } })).capabilities).toEqual([]);

    const discovered = body<{ tools: Array<{ name: string }> }>(
      await admin.client.callTool({ name: "capabilities", arguments: { op: "discover", endpoint_url: "https://github.example.com/mcp" } }),
    );
    expect(discovered.tools.map((t) => t.name)).toEqual(["search", "create_issue"]);

    const connected = body<{ status: string; capability: { id: string; key: string } }>(
      await admin.client.callTool({
        name: "capabilities_write",
        arguments: { op: "connect", key: "issues", endpoint_url: "https://github.example.com/mcp", tools: ["create_issue"] },
      }),
    );
    expect(connected.status).toBe("connected");
    const capabilityId = connected.capability.id;

    // Connecting grants nobody — not even the admin that connected it.
    expect(await searchRefs(admin.client)).not.toContain("github/issues/create_issue");
    const listed = body<{ capabilities: Array<{ id: string; granted_to_me: boolean }> }>(
      await admin.client.callTool({ name: "capabilities", arguments: { op: "list" } }),
    );
    expect(listed.capabilities).toEqual([expect.objectContaining({ id: capabilityId, granted_to_me: false })]);

    const granted = body<{ grant: { id: string } }>(
      await admin.client.callTool({ name: "capabilities_write", arguments: { op: "grant", capability_id: capabilityId } }),
    );
    expect(await searchRefs(admin.client)).toContain("github/issues/create_issue");
    // The editor was not granted: nothing changed for it. And tools/list did
    // not change for the admin either — a grant is found, never listed.
    expect(await searchRefs(editor.client)).not.toContain("github/issues/create_issue");
    const toolNames = (await admin.client.listTools()).tools.map((t) => t.name);
    expect(toolNames).not.toContain("github/issues/create_issue");
    expect(toolNames).toContain("capability_search");
    expect(toolNames).toContain("capability_call");

    // And it is callable — re-authorized through the same catalog.
    const called = await admin.client.callTool({ name: "capability_call", arguments: { ref: "github/issues/create_issue", args: { title: "x" } } });
    expect(called.isError).toBeFalsy();

    const status = body<{ capability: { grants: unknown[] } }>(
      await admin.client.callTool({ name: "capabilities", arguments: { op: "status", capability_id: capabilityId } }),
    );
    expect(status.capability.grants).toHaveLength(1);

    const revoked = body<{ revoked: boolean }>(
      await admin.client.callTool({ name: "capabilities_write", arguments: { op: "revoke", grant_id: granted.grant.id } }),
    );
    expect(revoked.revoked).toBe(true);
    expect(await searchRefs(admin.client)).not.toContain("github/issues/create_issue");
  });

  it("hands OAuth back as a URL to consent to, and connects once the attempt is authorized", async () => {
    const started = body<{ status: string; attempt_id: string; authorization_url: string }>(
      await admin.client.callTool({
        name: "capabilities_write",
        arguments: { op: "connect", key: "gh", endpoint_url: "https://github.example.com/mcp", auth: { type: "oauth" } },
      }),
    );
    expect(started.status).toBe("authorization_required");
    expect(started.authorization_url).toMatch(/^https:\/\/auth\.example\.com\//);
    expect(fake.capabilities).toHaveLength(0);

    const pending = body<{ attempt: { status: string } }>(
      await admin.client.callTool({ name: "capabilities", arguments: { op: "status", attempt_id: started.attempt_id } }),
    );
    expect(pending.attempt.status).toBe("pending");

    const tooEarly = await admin.client.callTool({
      name: "capabilities_write",
      arguments: { op: "connect", key: "gh", endpoint_url: "https://github.example.com/mcp", auth: { type: "oauth", attempt_id: started.attempt_id } },
    });
    expect(tooEarly.isError).toBe(true);
    expect(text(tooEarly)).toMatch(/oauth_attempt_not_authorized/);

    // A person consented in the browser.
    fake.attempts.get(started.attempt_id)!.status = "authorized";
    const connected = body<{ status: string }>(
      await admin.client.callTool({
        name: "capabilities_write",
        arguments: { op: "connect", key: "gh", endpoint_url: "https://github.example.com/mcp", auth: { type: "oauth", attempt_id: started.attempt_id } },
      }),
    );
    expect(connected.status).toBe("connected");
  });

  it("disconnect revokes every grant and the tools vanish from capability_search", async () => {
    const connected = body<{ capability: { id: string } }>(
      await admin.client.callTool({
        name: "capabilities_write",
        arguments: { op: "connect", key: "issues", endpoint_url: "https://github.example.com/mcp" },
      }),
    );
    await admin.client.callTool({ name: "capabilities_write", arguments: { op: "grant", capability_id: connected.capability.id, allowed_tools: ["search"] } });
    let refs = await searchRefs(admin.client);
    expect(refs).toContain("github/issues/search");
    expect(refs).not.toContain("github/issues/create_issue");

    const removed = body<{ grants_revoked: number }>(
      await admin.client.callTool({ name: "capabilities_write", arguments: { op: "disconnect", capability_id: connected.capability.id } }),
    );
    expect(removed.grants_revoked).toBe(1);
    refs = await searchRefs(admin.client);
    expect(refs).not.toContain("github/issues/search");
    const gone = await admin.client.callTool({ name: "capability_call", arguments: { ref: "github/issues/search", args: {} } });
    expect(gone.isError).toBe(true);
  });

  it("takes a static token in auth.secret, write-only, and refuses the retired env reference", async () => {
    const description = (await admin.client.listTools()).tools.find((t) => t.name === "capabilities_write")!.description!;
    expect(description).toMatch(/auth\.secret/);
    expect(description).toMatch(/never returned/);

    const connected = await admin.client.callTool({
      name: "capabilities_write",
      arguments: { op: "connect", key: "issues", endpoint_url: "https://github.example.com/mcp", auth: { type: "bearer", secret: "ghp_pasted_once" } },
    });
    expect(connected.isError, text(connected)).toBeFalsy();
    expect(text(connected)).not.toContain("ghp_pasted_once");
    const status = await admin.client.callTool({ name: "capabilities", arguments: { op: "status", capability_id: body<{ capability: { id: string } }>(connected).capability.id } });
    expect(text(status)).not.toContain("ghp_pasted_once");

    const legacy = await admin.client.callTool({
      name: "capabilities_write",
      arguments: { op: "connect", key: "legacy", endpoint_url: "https://github.example.com/mcp", auth: { type: "bearer", secret_ref: "BCONTEXT_CAP_GITHUB" } },
    });
    expect(legacy.isError).toBe(true);
    expect(fake.capabilities.map((c) => c.key)).toEqual(["issues"]);
  });

  it("rejects malformed input before touching the catalog", async () => {
    const http = await admin.client.callTool({
      name: "capabilities_write",
      arguments: { op: "connect", key: "issues", endpoint_url: "http://github.example.com/mcp" },
    });
    expect(http.isError).toBe(true);
    expect(text(http)).toMatch(/HTTPS/);
    const badKey = await admin.client.callTool({
      name: "capabilities_write",
      arguments: { op: "connect", key: "Bad Key", endpoint_url: "https://github.example.com/mcp" },
    });
    expect(badKey.isError).toBe(true);
    expect(fake.capabilities).toHaveLength(0);
  });
});
