import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthorizedCapabilityTool } from "./types";

// Just enough of the admin client for one webhook invocation: the ledger
// row, the rate-limit RPC, the circuit state and the runtime upsert.
vi.mock("@/lib/supabase/admin", () => {
  const chain = () => {
    const self: Record<string, unknown> = {};
    for (const m of ["select", "eq", "insert", "update", "upsert", "is", "in"]) self[m] = () => self;
    self.single = async () => ({ data: { id: "inv-1" }, error: null });
    self.maybeSingle = async () => ({ data: null, error: null });
    self.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
    return self;
  };
  return {
    getSupabaseAdmin: () => ({
      from: () => chain(),
      rpc: () => ({ single: async () => ({ data: { allowed: true, retry_after_sec: 0 }, error: null }) }),
    }),
  };
});
vi.mock("@/lib/audit", () => ({ appendAudit: vi.fn(async () => {}) }));
const getSecret = vi.fn();
vi.mock("@/lib/connectors/secrets", () => ({ getSecret: (...a: unknown[]) => getSecret(...a) }));
const upstream = vi.fn(async (_input: URL | string, _init?: RequestInit) =>
  new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
vi.mock("./egress", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./egress")>()),
  createPinnedFetch: () => (input: URL | string, init?: RequestInit) => upstream(input, init),
}));

import { CapabilityGatewayError, invokeAuthorizedCapability, isUnauthorizedTransportError } from "./gateway";

const VAULT = "vault:0b8f5c3e-2f6a-4b1c-9d3e-7a8b9c0d1e2f";

function webhookTool(connection: Partial<AuthorizedCapabilityTool["connection"]>): AuthorizedCapabilityTool {
  return {
    workspaceId: "ws-1",
    ref: "example/hook/run",
    remoteName: "run",
    description: "",
    capabilityTitle: "Hook",
    inputSchema: { type: "object" },
    capabilityId: "cap-1",
    capabilityVersionId: "v-1",
    capabilityKey: "hook",
    capabilityType: "workflow",
    provider: "example",
    principalId: "p-1",
    contract: { protocol: "webhook", tool: { name: "run", description: "", inputSchema: { type: "object" } }, method: "POST", safeRetry: false },
    connection: {
      id: "conn-1",
      endpointUrl: "https://hooks.example.com/run",
      authType: "bearer",
      authHeaderName: null,
      secretRef: VAULT,
      allowedHosts: ["hooks.example.com"],
      timeoutMs: 5000,
      ...connection,
    },
    constraints: {},
  };
}

function sentHeaders(): Headers {
  return new Headers(upstream.mock.calls[0]![1]?.headers);
}

afterEach(() => {
  getSecret.mockReset();
  upstream.mockClear();
});

describe("static credentials come from Vault", () => {
  it("sends Authorization: Bearer with the token resolved from the reference", async () => {
    getSecret.mockResolvedValue("ghp_resolved");
    await invokeAuthorizedCapability(webhookTool({}), { a: 1 }, { workspaceId: "ws-1", tokenId: "tok" });
    expect(getSecret).toHaveBeenCalledWith(VAULT);
    expect(sentHeaders().get("authorization")).toBe("Bearer ghp_resolved");
  });

  it("sends the custom header for header auth", async () => {
    getSecret.mockResolvedValue("key_resolved");
    await invokeAuthorizedCapability(
      webhookTool({ authType: "header", authHeaderName: "x-api-key" }),
      {},
      { workspaceId: "ws-1", tokenId: "tok" },
    );
    expect(sentHeaders().get("x-api-key")).toBe("key_resolved");
    expect(sentHeaders().get("authorization")).toBeNull();
  });

  it("never reads the process environment: a missing Vault entry is secret_unavailable", async () => {
    process.env.BCONTEXT_CAP_LEGACY = "should-not-be-read";
    try {
      getSecret.mockResolvedValue(null);
      const failure = await invokeAuthorizedCapability(webhookTool({}), {}, { workspaceId: "ws-1", tokenId: "tok" }).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(CapabilityGatewayError);
      expect((failure as CapabilityGatewayError).code).toBe("secret_unavailable");
      expect(upstream).not.toHaveBeenCalled();

      const missing = await invokeAuthorizedCapability(webhookTool({ secretRef: null }), {}, { workspaceId: "ws-1", tokenId: "tok" }).catch((e: unknown) => e);
      expect((missing as CapabilityGatewayError).code).toBe("secret_ref_missing");
      expect(getSecret).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.BCONTEXT_CAP_LEGACY;
    }
  });
});

describe("OAuth transport retry classification", () => {
  it("retries only a structured Streamable HTTP 401", () => {
    expect(isUnauthorizedTransportError(
      new StreamableHTTPError(401, "Unauthorized"),
    )).toBe(true);
    expect(isUnauthorizedTransportError(
      new StreamableHTTPError(403, "Forbidden"),
    )).toBe(false);
  });

  it("does not trust provider-controlled error text", () => {
    expect(isUnauthorizedTransportError(
      new Error("401 unauthorized: invalid token"),
    )).toBe(false);
    expect(isUnauthorizedTransportError({
      code: 401,
      message: "Unauthorized",
    })).toBe(false);
  });
});
