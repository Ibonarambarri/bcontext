/**
 * The token endpoint's reading of `resource` (RFC 8707): a value that is not
 * one of this server's MCP endpoints is `invalid_target` before any credential
 * is checked, and one that is reaches the grant as the parsed endpoint. The
 * binding itself (does the grant belong to that workspace) is the grant's
 * job, covered in `src/lib/auth/oauth.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const calls: Array<Record<string, unknown>> = [];

vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => ({}) }));
vi.mock("@/lib/auth/oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/oauth")>()),
  redeemCode: async (_admin: unknown, input: Record<string, unknown>) => {
    calls.push(input);
    return { access_token: "bctx_live_x", token_type: "Bearer", scope: "nodes:read", workspace_id: "ws-1", scope_kind: "workspace" };
  },
  refreshAccessToken: async (_admin: unknown, input: Record<string, unknown>) => {
    calls.push(input);
    return { access_token: "bctx_live_y", token_type: "Bearer", scope: "nodes:read", workspace_id: "ws-1", scope_kind: "workspace" };
  },
}));

import { POST } from "./route";

function post(fields: Record<string, string>): Promise<Response> {
  const form = new URLSearchParams(fields);
  return POST(
    new Request("http://localhost/api/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
  );
}

const CODE = {
  grant_type: "authorization_code",
  code: "c",
  client_id: "client-1",
  client_secret: "s",
  redirect_uri: "https://client.test/cb",
  code_verifier: "v",
};

afterEach(() => {
  calls.length = 0;
});

describe("POST /api/oauth/token — resource", () => {
  it("hands the grant the parsed endpoint", async () => {
    const res = await post({ ...CODE, resource: "http://localhost/mcp/acme/docs" });
    expect(res.status).toBe(200);
    expect(calls[0]!.resource).toEqual({ kind: "workspace", ref: { org: "acme", workspace: "docs" }, name: "acme/docs" });
  });

  it("binds nothing when the client sends no resource", async () => {
    const res = await post(CODE);
    expect(res.status).toBe(200);
    expect(calls[0]!.resource).toBeUndefined();
  });

  it("refuses a resource that is not this server's MCP, on both grants, before credentials", async () => {
    for (const body of [CODE, { grant_type: "refresh_token", refresh_token: "r", client_id: "client-1", client_secret: "s" }]) {
      const res = await post({ ...body, resource: "https://elsewhere.test/mcp/acme/docs" });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_target" });
    }
    expect(calls).toHaveLength(0);
  });
});
