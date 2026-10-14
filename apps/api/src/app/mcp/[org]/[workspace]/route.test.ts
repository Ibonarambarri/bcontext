/**
 * What the per-workspace endpoint adds on top of `/mcp`, tested through the
 * route with auth mocked: the path is the workspace selector (handed to the
 * resolver as `<org>/<workspace>`, normalised), a pair that is not two slugs
 * is a 404 before any token is looked at, and a `ping` answers from the
 * workspace the path named.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspace } from "@/lib/demo-store";

const state = { workspaceId: "" };
const resolve = vi.fn(async (..._args: unknown[]) => ({ workspaceId: state.workspaceId, slug: "telemetry" }));
const gateCalls = vi.fn();

vi.mock("@/lib/auth/require", () => ({
  gate: async () => {
    gateCalls();
    return {
      kind: "agent_user",
      userId: "u1",
      scopes: ["nodes:read"],
      tokenId: "tok-1",
      agentId: null,
    };
  },
  resolveAgentWorkspaceOr401: (...args: unknown[]) => resolve(...args),
  actingUserId: () => "u1",
}));
vi.mock("@/lib/auth/grants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/grants")>()),
  resolveGrant: async (_actor: unknown, workspaceId: string) => ({
    workspaceId,
    principal: { kind: "user", id: "u1" },
    verbs: ["read"],
    reach: { type: "all" },
  }),
}));
vi.mock("@/lib/agents/names", () => ({
  agentDisplayName: async () => null,
  agentDisplayNames: async () => new Map<string, string>(),
}));
vi.mock("@/lib/capabilities/catalog", () => ({ listAuthorizedCapabilityTools: async () => [] }));
vi.mock("@/lib/capabilities/gateway", () => ({
  CapabilityGatewayError: class extends Error {},
  invokeAuthorizedCapability: vi.fn(),
}));

import { POST } from "./route";

function ping(org: string, workspace: string): Promise<Response> {
  return POST(
    new Request(`https://api.example.com/mcp/${encodeURIComponent(org)}/${encodeURIComponent(workspace)}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } }),
    }),
    { params: Promise.resolve({ org, workspace }) },
  );
}

beforeEach(() => {
  state.workspaceId = createWorkspace({ name: "Telemetry", slug: `telemetry-${Date.now()}` }).id;
  resolve.mockClear();
  gateCalls.mockClear();
});

describe("POST /mcp/:org/:workspace", () => {
  it("hands the path to the resolver as the workspace selector, normalised", async () => {
    const res = await ping("Acme", "Telemetry");
    expect(res.status).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]![2]).toEqual({ workspaceRef: "acme/telemetry" });
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
    expect(body.result.content[0]!.text).toMatch(/^pong/);
  });

  it("404s a pair that is not two slugs before looking at the token", async () => {
    const res = await ping("acme inc", "telemetry");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "workspace_not_found" });
    expect(gateCalls).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
});
