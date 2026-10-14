/**
 * `admin_write(op=grant|invite)` widens someone's privileges, so when the
 * connected client can put a question to its user (MCP elicitation) the grant
 * is spelled out and confirmed before anything is written. A client without
 * the capability proceeds as before and the receipt says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, type ClientOptions } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";

const mocks = vi.hoisted(() => ({
  listAuthorizedCapabilityTools: vi.fn(),
  grantAccess: vi.fn(),
  inviteToWorkspace: vi.fn(),
}));
vi.mock("@/lib/capabilities/catalog", () => ({ listAuthorizedCapabilityTools: mocks.listAuthorizedCapabilityTools }));
vi.mock("@/lib/capabilities/gateway", () => ({ CapabilityGatewayError: class extends Error {}, invokeAuthorizedCapability: vi.fn() }));
vi.mock("@/lib/auth/admin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/admin")>()),
  grantAccess: mocks.grantAccess,
}));
vi.mock("@/lib/auth/invitations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/invitations")>()),
  inviteToWorkspace: mocks.inviteToWorkspace,
}));

import { buildMcpServer } from "./server";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
function text(result: ToolResult): string {
  return (result as { content: Array<{ type: string; text?: string }> }).content[0]?.text ?? "";
}
function body<T = Record<string, unknown>>(result: ToolResult): T {
  return JSON.parse(text(result)) as T;
}

const GRANT_ARGS = {
  op: "grant",
  principal: { kind: "agent", id: "agent-2" },
  verbs: ["read", "write"],
  reach: { type: "all" },
};
const INVITE_ARGS = {
  op: "invite",
  email: "new@example.com",
  verbs: ["read"],
  reach: { type: "all" },
};

describe("admin_write elicitation on privilege widening", () => {
  let close: () => Promise<void> = async () => {};

  beforeEach(() => {
    mocks.listAuthorizedCapabilityTools.mockReset().mockResolvedValue([]);
    mocks.grantAccess.mockReset().mockResolvedValue({ principal_kind: "agent", principal_id: "agent-2", verbs: ["read", "write"] });
    mocks.inviteToWorkspace.mockReset().mockResolvedValue({ status: "pending", email: "new@example.com" });
  });
  afterEach(async () => close());

  async function connect(
    options: ClientOptions | undefined,
    answer?: (question: string) => Promise<ElicitResult> | ElicitResult,
  ): Promise<{ client: Client; questions: string[] }> {
    const slug = `mcp-elicit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = createWorkspace({ name: "Elicit", slug });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer({
      workspaceId: workspace.id, workspaceRef: slug, scopes: ["nodes:read", "nodes:write", "admin:*"], tokenId: "t", tokenScope: "workspace", subjectUserId: null,
      grant: { workspaceId: workspace.id, principal: { kind: "user", id: "owner" }, verbs: ["read", "write", "admin"], reach: { type: "all" } } as never,
      storage: resolveDemoStorage(slug)!,
    } as never);
    const client = new Client({ name: "t", version: "0" }, options);
    const questions: string[] = [];
    if (answer) {
      client.setRequestHandler(ElicitRequestSchema, async (req) => {
        questions.push(req.params.message);
        return answer(req.params.message);
      });
    }
    await server.connect(st);
    await client.connect(ct);
    close = async () => { await client.close(); await server.close(); };
    return { client, questions };
  }

  it("asks a form-capable client to confirm a grant and writes only after `confirm: true`", async () => {
    const { client, questions } = await connect(
      { capabilities: { elicitation: { form: {} } } },
      () => ({ action: "accept", content: { confirm: true } }),
    );
    const res = await client.callTool({ name: "admin_write", arguments: GRANT_ARGS });
    expect(res.isError).toBeFalsy();
    expect(body(res)).toMatchObject({ elicitation: "confirmed", granted: { principal_id: "agent-2" } });
    expect(questions).toEqual(["Grant read, write with reach all nodes to agent agent-2? yes/no"]);
    expect(mocks.grantAccess).toHaveBeenCalledTimes(1);
  });

  it("aborts and writes nothing when the person declines", async () => {
    const { client } = await connect(
      { capabilities: { elicitation: { form: {} } } },
      () => ({ action: "decline" }),
    );
    const res = await client.callTool({ name: "admin_write", arguments: GRANT_ARGS });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/aborted: the confirmation was declined; nothing was granted/);
    expect(mocks.grantAccess).not.toHaveBeenCalled();
  });

  it("treats cancel and `confirm: false` as a refusal", async () => {
    const { client } = await connect(
      { capabilities: { elicitation: { form: {} } } },
      (q) => (q.includes("agent-2") ? { action: "cancel" } : { action: "accept", content: { confirm: false } }),
    );
    const grant = await client.callTool({ name: "admin_write", arguments: GRANT_ARGS });
    expect(grant.isError).toBe(true);
    expect(text(grant)).toMatch(/cancelled/);
    const invite = await client.callTool({ name: "admin_write", arguments: INVITE_ARGS });
    expect(invite.isError).toBe(true);
    expect(text(invite)).toMatch(/not answered with confirm=true/);
    expect(mocks.grantAccess).not.toHaveBeenCalled();
    expect(mocks.inviteToWorkspace).not.toHaveBeenCalled();
  });

  it("aborts when the client errors instead of answering", async () => {
    const { client } = await connect(
      { capabilities: { elicitation: { form: {} } } },
      () => { throw new Error("no user attached"); },
    );
    const res = await client.callTool({ name: "admin_write", arguments: INVITE_ARGS });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/did not answer the confirmation/);
    expect(mocks.inviteToWorkspace).not.toHaveBeenCalled();
  });

  it("confirms an invitation, naming the address and the verbs it will carry", async () => {
    const { client, questions } = await connect(
      { capabilities: { elicitation: { form: {} } } },
      () => ({ action: "accept", content: { confirm: true } }),
    );
    const res = await client.callTool({ name: "admin_write", arguments: INVITE_ARGS });
    expect(res.isError).toBeFalsy();
    expect(body(res)).toMatchObject({ elicitation: "confirmed", invitation: { email: "new@example.com" } });
    expect(questions[0]).toBe("Grant read with reach all nodes to new@example.com (invitation, effective when they accept)? yes/no");
    expect(mocks.inviteToWorkspace).toHaveBeenCalledTimes(1);
  });

  it("still asks a 2025-06-18 client that declares the bare `elicitation: {}` capability", async () => {
    const { client, questions } = await connect(
      { capabilities: { elicitation: {} } },
      () => ({ action: "accept", content: { confirm: true } }),
    );
    const res = await client.callTool({ name: "admin_write", arguments: GRANT_ARGS });
    expect(res.isError).toBeFalsy();
    expect(body(res)).toMatchObject({ elicitation: "confirmed" });
    expect(questions).toHaveLength(1);
  });

  it("proceeds without asking when the client has no elicitation capability, and says so", async () => {
    const { client } = await connect(undefined);
    const grant = await client.callTool({ name: "admin_write", arguments: GRANT_ARGS });
    expect(grant.isError).toBeFalsy();
    expect(body(grant)).toMatchObject({ elicitation: "unsupported_by_client", granted: { principal_id: "agent-2" } });
    const invite = await client.callTool({ name: "admin_write", arguments: INVITE_ARGS });
    expect(invite.isError).toBeFalsy();
    expect(body(invite)).toMatchObject({ elicitation: "unsupported_by_client" });
    expect(mocks.grantAccess).toHaveBeenCalledTimes(1);
    expect(mocks.inviteToWorkspace).toHaveBeenCalledTimes(1);
  });

  it("does not ask about a grant the caller could never make; the refusal comes from the domain", async () => {
    // `delete` is not held by the caller, so canGrant refuses up front: the person
    // is not bothered with a question whose answer cannot matter.
    mocks.grantAccess.mockRejectedValue(Object.assign(new Error("cannot grant more than you hold"), { name: "GrantError" }));
    const { client, questions } = await connect(
      { capabilities: { elicitation: { form: {} } } },
      () => ({ action: "accept", content: { confirm: true } }),
    );
    const res = await client.callTool({
      name: "admin_write",
      arguments: { ...GRANT_ARGS, verbs: ["read", "write", "delete"] },
    });
    expect(res.isError).toBe(true);
    expect(questions).toHaveLength(0);
  });
});
