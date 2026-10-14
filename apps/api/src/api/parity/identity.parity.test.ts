/**
 * Group: /api/agents, /api/tokens, /api/oauth, /api/me, /mcp, /api/audit,
 * /api/admin.
 *
 * Identity and the agent surface. Nearly every route here wants a Supabase
 * session or a token lookup, and the test process has neither: cookie routes
 * fail inside `getSupabaseForRequest` and come back as withRoute's 500, bearer
 * routes fail in `getSupabaseAdmin` the same way, and the rest resolve to the
 * `demo` actor. Those answers are still the ones to compare — a 400 from zod
 * proves the body arrived intact, a 400 from a param schema proves Hono filled
 * `:id` as the route convention does, a 500 proves the exception path is not
 * swallowed —
 * so each route gets both a plausible request and a clearly broken one.
 *
 * Two things are covered beyond `assertParity`. The `/mcp` 401 must carry
 * `WWW-Authenticate` with `resource_metadata` (MCP clients start OAuth
 * discovery from it), and the snapshot does not keep arbitrary headers, so it
 * is compared on the raw responses. And the MCP JSON-RPC round trip is the one
 * success path worth stubbing for: `verifyToken` and the admin client are
 * replaced for a single fake token so `initialize`, `tools/list` and
 * `tools/call` go through the HTTP route, over the demo workspace, both ways.
 * The stubs are pass-through unless the MCP block switches them on, so the
 * other routes see the same environment every group sees.
 *
 * Not asserted here: `DELETE /api/tokens/user` has no handler in the literal
 * module, and bare Hono would fall through to `/api/tokens/:id` with
 * `id = "user"`. The adapter's per-path catch-all answers 405 instead;
 * `route-order.test.ts` covers that for every literal/param sibling pair.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApiApp } from "../app";
import type { RouteHandler, RouteModule } from "../adapter";
import { assertParity, buildRequest, type ParityRequest } from "./harness";
import * as adminMetrics from "@/app/api/admin/metrics/route";
import * as connections from "@/app/api/agents/connections/route";
import * as connectionModule from "@/app/api/agents/connections/[id]/route";
import * as agentContext from "@/app/api/agents/context/route";
import * as agentWrite from "@/app/api/agents/write/route";
import * as auditVerify from "@/app/api/audit/verify/route";
import * as meWorkspaces from "@/app/api/me/workspaces/route";
import * as oauthAuthorize from "@/app/api/oauth/authorize/route";
import * as oauthRegister from "@/app/api/oauth/register/route";
import * as oauthRevoke from "@/app/api/oauth/revoke/route";
import * as oauthToken from "@/app/api/oauth/token/route";
import * as tokens from "@/app/api/tokens/route";
import * as tokenModule from "@/app/api/tokens/[id]/route";
import * as userTokens from "@/app/api/tokens/user/route";
import * as userTokenModule from "@/app/api/tokens/user/[id]/route";
import * as mcp from "@/app/mcp/route";
import * as mcpWorkspaceModule from "@/app/mcp/[org]/[workspace]/route";

// Dynamic-segment modules type their params as `Promise<{ id: string }>`, narrower
// than the adapter's `Record<string, string>`; the generated table casts for the
// same reason.
const connection = connectionModule as unknown as RouteModule;
const token = tokenModule as unknown as RouteModule;
const userToken = userTokenModule as unknown as RouteModule;
const mcpWorkspace = mcpWorkspaceModule as unknown as RouteModule;

/** The seeded demo workspace `bcontext`; `getStorageById` falls back to it without Supabase. */
const DEMO_WORKSPACE_ID = "00000000-0000-0000-0000-000000000010";
const GOOD_TOKEN = "Bearer bctx_live_parity";
const BAD_TOKEN = "Bearer bctx_live_parity_revoked";

const stubs = vi.hoisted(() => ({ mcp: false }));

vi.mock("@/lib/auth/tokens", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/tokens")>();
  return {
    ...actual,
    verifyToken: async (admin: never, header: string | null | undefined) => {
      if (!stubs.mcp) return actual.verifyToken(admin, header);
      if (header !== GOOD_TOKEN) return null;
      return {
        scope: "workspace",
        workspaceId: DEMO_WORKSPACE_ID,
        scopes: ["nodes:read", "nodes:write", "agents:read", "agents:write"],
        tokenId: "tok-parity",
        createdBy: null,
        // No agent attached: the grant then derives from the token's own scopes
        // and needs no `workspace_grants` row, which keeps the stub to one query.
        agentId: null,
      };
    },
  };
});

vi.mock("@/lib/supabase/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/admin")>();
  // The only query a workspace token triggers before reaching the transport is
  // `resolveAgentWorkspaceOr401`'s slug lookup (with the organization joined
  // in when the path names the workspace). Anything else would be a change in
  // the route worth knowing about, so the stub answers that and nothing more.
  const workspaces = {
    select: () => workspaces,
    eq: () => workspaces,
    maybeSingle: async () => ({ data: { slug: "bcontext", organization: { slug: "acme" } }, error: null }),
  };
  const admin = {
    from: (table: string) => {
      if (table !== "workspaces") throw new Error(`parity stub: unexpected query on ${table}`);
      return workspaces;
    },
  };
  return { ...actual, getSupabaseAdmin: () => (stubs.mcp ? admin : actual.getSupabaseAdmin()) };
});

const app = createApiApp({
  serve: ["/api/agents", "/api/tokens", "/api/oauth", "/api/me", "/mcp", "/api/audit", "/api/admin"],
});

const UUID = "8f3c1d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const MCP_ACCEPT = { accept: "application/json, text/event-stream" };

/** Same request both ways, compared on one header the snapshot does not keep. */
async function assertHeaderParity(module: RouteModule, r: ParityRequest, header: string): Promise<string | null> {
  const handler = module[r.method] as RouteHandler;
  const direct = await handler(buildRequest(r), { params: Promise.resolve(r.params ?? {}) });
  const viaHono = await app.request(buildRequest(r));
  expect(viaHono.headers.get(header)).toBe(direct.headers.get(header));
  return direct.headers.get(header);
}

describe("parity: admin", () => {
  it("GET /api/admin/metrics", () => assertParity(app, adminMetrics, { method: "GET", path: "/api/admin/metrics?months=3" }));
  it("GET /api/admin/metrics (months out of range)", () =>
    assertParity(app, adminMetrics, { method: "GET", path: "/api/admin/metrics?months=abc" }));
});

describe("parity: agent connections", () => {
  it("GET /api/agents/connections", () =>
    assertParity(app, connections, { method: "GET", path: "/api/agents/connections?workspace=bcontext" }));
  it("GET /api/agents/connections (no workspace)", () =>
    assertParity(app, connections, { method: "GET", path: "/api/agents/connections" }));

  it("PATCH /api/agents/connections/:id", () =>
    assertParity(app, connection, {
      method: "PATCH",
      path: `/api/agents/connections/${UUID}`,
      params: { id: UUID },
      body: { workspace: "bcontext", role: "custom", scopes: ["nodes:read"] },
    }));
  it("PATCH /api/agents/connections/:id (bad body)", () =>
    assertParity(app, connection, {
      method: "PATCH",
      path: `/api/agents/connections/${UUID}`,
      params: { id: UUID },
      body: { role: "god" },
    }));
  it("PATCH /api/agents/connections/:id (bad id)", () =>
    assertParity(app, connection, {
      method: "PATCH",
      path: "/api/agents/connections/not-a-uuid",
      params: { id: "not-a-uuid" },
      body: { workspace: "bcontext", role: "custom", scopes: ["nodes:read"] },
    }));

  it("DELETE /api/agents/connections/:id", () =>
    assertParity(app, connection, {
      method: "DELETE",
      path: `/api/agents/connections/${UUID}?workspace=bcontext`,
      params: { id: UUID },
    }));
  it("DELETE /api/agents/connections/:id (no workspace)", () =>
    assertParity(app, connection, { method: "DELETE", path: `/api/agents/connections/${UUID}`, params: { id: UUID } }));
  it("DELETE /api/agents/connections/:id (bad id)", () =>
    assertParity(app, connection, {
      method: "DELETE",
      path: "/api/agents/connections/nope?workspace=bcontext",
      params: { id: "nope" },
    }));
});

describe("parity: agent surface", () => {
  it("POST /api/agents/context", () =>
    assertParity(app, agentContext, {
      method: "POST",
      path: "/api/agents/context",
      body: { workspace: "bcontext", query: "embedding pipeline", k: 3, fields: ["id", "kind", "title"] },
    }));
  it("POST /api/agents/context (unknown workspace)", () =>
    assertParity(app, agentContext, { method: "POST", path: "/api/agents/context", body: { workspace: "no-such-workspace" } }));
  it("POST /api/agents/context (k out of range)", () =>
    assertParity(app, agentContext, { method: "POST", path: "/api/agents/context", body: { workspace: "bcontext", k: 999 } }));
  it("POST /api/agents/context (not JSON)", () =>
    assertParity(app, agentContext, { method: "POST", path: "/api/agents/context", body: "{not json" }));

  it("POST /api/agents/write", () =>
    assertParity(app, agentWrite, {
      method: "POST",
      path: "/api/agents/write",
      body: {
        workspace: "bcontext",
        ops: [{ op: "create", node: { title: "Parity note", kind: "doc", parent_id: null, content_md: "## Body\n\nhello" } }],
      },
    }));
  it("POST /api/agents/write (patch missing node)", () =>
    assertParity(app, agentWrite, {
      method: "POST",
      path: "/api/agents/write",
      body: { workspace: "bcontext", ops: [{ op: "patch", id: "does-not-exist", patch: { title: "x" } }] },
    }));
  it("POST /api/agents/write (no workspace)", () =>
    assertParity(app, agentWrite, { method: "POST", path: "/api/agents/write", body: { ops: [] } }));
  it("POST /api/agents/write (unknown op)", () =>
    assertParity(app, agentWrite, {
      method: "POST",
      path: "/api/agents/write",
      body: { workspace: "bcontext", ops: [{ op: "drop", id: "x" }] },
    }));
  it("POST /api/agents/write (bearer without DB)", () =>
    assertParity(app, agentWrite, {
      method: "POST",
      path: "/api/agents/write",
      headers: { authorization: "Bearer bctx_live_nope" },
      body: { workspace: "bcontext", ops: [] },
    }));
});

describe("parity: audit", () => {
  it("GET /api/audit/verify", () => assertParity(app, auditVerify, { method: "GET", path: "/api/audit/verify?workspace=bcontext" }));
  it("GET /api/audit/verify (no workspace)", () => assertParity(app, auditVerify, { method: "GET", path: "/api/audit/verify" }));
  it("GET /api/audit/verify (unknown workspace)", () =>
    assertParity(app, auditVerify, { method: "GET", path: "/api/audit/verify?workspace=no-such-workspace" }));
});

describe("parity: me", () => {
  it("GET /api/me/workspaces", () => assertParity(app, meWorkspaces, { method: "GET", path: "/api/me/workspaces" }));
  it("GET /api/me/workspaces (bearer without DB)", () =>
    assertParity(app, meWorkspaces, {
      method: "GET",
      path: "/api/me/workspaces",
      headers: { authorization: "Bearer bctx_live_nope" },
    }));
});

describe("parity: oauth", () => {
  it("POST /api/oauth/register", () =>
    assertParity(app, oauthRegister, {
      method: "POST",
      path: "/api/oauth/register",
      body: { client_name: "Parity MCP client", redirect_uris: ["http://localhost:6274/oauth/callback"], scope: "nodes:read" },
    }));
  it("POST /api/oauth/register (invalid metadata)", () =>
    assertParity(app, oauthRegister, {
      method: "POST",
      path: "/api/oauth/register",
      body: { client_name: "", redirect_uris: ["not a url"] },
    }));
  it("POST /api/oauth/register (not JSON)", () =>
    assertParity(app, oauthRegister, { method: "POST", path: "/api/oauth/register", body: "client_name=x", headers: FORM }));
  it("POST /api/oauth/register (empty Origin: bearer-only path skips the guard)", () =>
    assertParity(app, oauthRegister, {
      method: "POST",
      path: "/api/oauth/register",
      headers: { origin: "", host: "" },
      body: { client_name: "" },
    }));

  it("POST /api/oauth/token (form, authorization_code)", () =>
    assertParity(app, oauthToken, {
      method: "POST",
      path: "/api/oauth/token",
      headers: FORM,
      body: "grant_type=authorization_code&code=abc&client_id=cid&client_secret=sec&redirect_uri=http%3A%2F%2Flocalhost%2Fcb&code_verifier=ver",
    }));
  it("POST /api/oauth/token (form, refresh_token)", () =>
    assertParity(app, oauthToken, {
      method: "POST",
      path: "/api/oauth/token",
      headers: FORM,
      body: "grant_type=refresh_token&refresh_token=rt&client_id=cid&client_secret=sec",
    }));
  it("POST /api/oauth/token (form, client_secret_basic)", () =>
    assertParity(app, oauthToken, {
      method: "POST",
      path: "/api/oauth/token",
      headers: { ...FORM, authorization: `Basic ${Buffer.from("cid:sec").toString("base64")}` },
      body: "grant_type=refresh_token&refresh_token=rt",
    }));
  it("POST /api/oauth/token (JSON, authorization_code)", () =>
    assertParity(app, oauthToken, {
      method: "POST",
      path: "/api/oauth/token",
      body: { grant_type: "authorization_code", code: "abc", client_id: "cid", client_secret: "sec", redirect_uri: "http://localhost/cb", code_verifier: "ver" },
    }));
  it("POST /api/oauth/token (form, missing fields)", () =>
    assertParity(app, oauthToken, { method: "POST", path: "/api/oauth/token", headers: FORM, body: "grant_type=authorization_code&code=abc" }));
  it("POST /api/oauth/token (unsupported grant)", () =>
    assertParity(app, oauthToken, { method: "POST", path: "/api/oauth/token", body: { grant_type: "password" } }));
  it("POST /api/oauth/token (empty body)", () => assertParity(app, oauthToken, { method: "POST", path: "/api/oauth/token" }));

  it("POST /api/oauth/revoke (form)", () =>
    assertParity(app, oauthRevoke, {
      method: "POST",
      path: "/api/oauth/revoke",
      headers: FORM,
      body: "token=rt&token_type_hint=refresh_token&client_id=cid&client_secret=sec",
    }));
  it("POST /api/oauth/revoke (JSON, client_secret_basic)", () =>
    assertParity(app, oauthRevoke, {
      method: "POST",
      path: "/api/oauth/revoke",
      headers: { authorization: `Basic ${Buffer.from("cid:sec").toString("base64")}` },
      body: { token: "rt" },
    }));
  it("POST /api/oauth/revoke (missing fields)", () =>
    assertParity(app, oauthRevoke, { method: "POST", path: "/api/oauth/revoke", body: { token: "rt" } }));
  it("POST /api/oauth/revoke (empty body)", () => assertParity(app, oauthRevoke, { method: "POST", path: "/api/oauth/revoke" }));

  it("POST /api/oauth/authorize (form)", () =>
    assertParity(app, oauthAuthorize, {
      method: "POST",
      path: "/api/oauth/authorize",
      headers: FORM,
      body: "client_id=cid&redirect_uri=http%3A%2F%2Flocalhost%2Fcb&code_challenge=ch&state=s1&decision=allow&workspace_ids=" + UUID,
    }));
  it("POST /api/oauth/authorize (multipart)", () =>
    assertParity(app, oauthAuthorize, {
      method: "POST",
      path: "/api/oauth/authorize",
      headers: { "content-type": "multipart/form-data; boundary=parity" },
      body: [
        "--parity",
        'Content-Disposition: form-data; name="client_id"',
        "",
        "cid",
        "--parity",
        'Content-Disposition: form-data; name="redirect_uri"',
        "",
        "http://localhost/cb",
        "--parity",
        'Content-Disposition: form-data; name="code_challenge"',
        "",
        "ch",
        "--parity--",
        "",
      ].join("\r\n"),
    }));
  it("POST /api/oauth/authorize (form, missing code_challenge)", () =>
    assertParity(app, oauthAuthorize, {
      method: "POST",
      path: "/api/oauth/authorize",
      headers: FORM,
      body: "client_id=cid&redirect_uri=http%3A%2F%2Flocalhost%2Fcb",
    }));
  it("POST /api/oauth/authorize (JSON is not a form)", () =>
    assertParity(app, oauthAuthorize, { method: "POST", path: "/api/oauth/authorize", body: { client_id: "cid" } }));
});

describe("parity: tokens", () => {
  it("GET /api/tokens", () => assertParity(app, tokens, { method: "GET", path: `/api/tokens?workspace_id=${UUID}` }));
  it("GET /api/tokens (bad workspace_id)", () => assertParity(app, tokens, { method: "GET", path: "/api/tokens?workspace_id=nope" }));
  it("POST /api/tokens", () =>
    assertParity(app, tokens, {
      method: "POST",
      path: "/api/tokens",
      body: { workspace_id: UUID, name: "ci", scopes: ["nodes:read"] },
    }));
  it("POST /api/tokens (bad scopes)", () =>
    assertParity(app, tokens, { method: "POST", path: "/api/tokens", body: { workspace_id: UUID, name: "ci", scopes: ["root"] } }));
  it("POST /api/tokens (not JSON)", () => assertParity(app, tokens, { method: "POST", path: "/api/tokens", body: "nope" }));

  it("DELETE /api/tokens/:id", () => assertParity(app, token, { method: "DELETE", path: `/api/tokens/${UUID}`, params: { id: UUID } }));
  it("DELETE /api/tokens/:id (bad id)", () =>
    assertParity(app, token, { method: "DELETE", path: "/api/tokens/nope", params: { id: "nope" } }));

  it("GET /api/tokens/user", () => assertParity(app, userTokens, { method: "GET", path: "/api/tokens/user" }));
  it("GET /api/tokens/user (bearer without DB)", () =>
    assertParity(app, userTokens, { method: "GET", path: "/api/tokens/user", headers: { authorization: "Bearer bctx_live_nope" } }));
  it("POST /api/tokens/user", () =>
    assertParity(app, userTokens, {
      method: "POST",
      path: "/api/tokens/user",
      body: { name: "laptop", scopes: ["nodes:read", "nodes:write"], provider: "claude_code", workspace_ids: [UUID] },
    }));
  it("POST /api/tokens/user (bad body)", () =>
    assertParity(app, userTokens, { method: "POST", path: "/api/tokens/user", body: { name: "", scopes: [] } }));
  it("POST /api/tokens/user (not JSON)", () => assertParity(app, userTokens, { method: "POST", path: "/api/tokens/user", body: "nope" }));

  it("DELETE /api/tokens/user/:id", () =>
    assertParity(app, userToken, { method: "DELETE", path: `/api/tokens/user/${UUID}`, params: { id: UUID } }));
  it("DELETE /api/tokens/user/:id (bad id)", () =>
    assertParity(app, userToken, { method: "DELETE", path: "/api/tokens/user/nope", params: { id: "nope" } }));
});

describe("parity: mcp (unauthenticated)", () => {
  it("GET /mcp", () => assertParity(app, mcp, { method: "GET", path: "/mcp" }));
  it("POST /mcp", () =>
    assertParity(app, mcp, {
      method: "POST",
      path: "/mcp",
      headers: MCP_ACCEPT,
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    }));
  it("POST /mcp (empty Origin: bearer-only path skips the guard)", () =>
    assertParity(app, mcp, { method: "POST", path: "/mcp", headers: { origin: "", host: "" }, body: {} }));
  it("POST /mcp (bearer without DB)", () =>
    assertParity(app, mcp, { method: "POST", path: "/mcp", headers: { authorization: "Bearer bctx_live_nope" }, body: {} }));

  it("401 advertises the same resource_metadata both ways", async () => {
    for (const method of ["GET", "POST"] as const) {
      const value = await assertHeaderParity(mcp, { method, path: "/mcp", body: method === "POST" ? {} : undefined }, "www-authenticate");
      expect(value).toContain('resource_metadata="');
      expect(value).toContain("/.well-known/oauth-protected-resource");
    }
  });
});

describe("parity: mcp per workspace (unauthenticated)", () => {
  const params = { org: "acme", workspace: "bcontext" };
  it("GET /mcp/:org/:workspace", () =>
    assertParity(app, mcpWorkspace, { method: "GET", path: "/mcp/acme/bcontext", params }));
  it("POST /mcp/:org/:workspace", () =>
    assertParity(app, mcpWorkspace, {
      method: "POST",
      path: "/mcp/acme/bcontext",
      params,
      headers: MCP_ACCEPT,
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    }));
  it("POST /mcp/:org/:workspace (malformed pair)", () =>
    assertParity(app, mcpWorkspace, {
      method: "POST",
      path: "/mcp/Acme%20Inc/bcontext",
      params: { org: "Acme Inc", workspace: "bcontext" },
      headers: MCP_ACCEPT,
      body: {},
    }));

  it("401 advertises the endpoint's own resource_metadata", async () => {
    for (const method of ["GET", "POST"] as const) {
      const value = await assertHeaderParity(
        mcpWorkspace,
        { method, path: "/mcp/acme/bcontext", params, body: method === "POST" ? {} : undefined },
        "www-authenticate",
      );
      expect(value).toContain('resource_metadata="');
      expect(value).toContain("/.well-known/oauth-protected-resource/mcp/acme/bcontext");
    }
  });
});

describe("parity: mcp (JSON-RPC over the route)", () => {
  beforeAll(() => {
    stubs.mcp = true;
  });
  afterAll(() => {
    stubs.mcp = false;
  });

  const authed = { authorization: GOOD_TOKEN, ...MCP_ACCEPT };

  it("POST /mcp initialize", () =>
    assertParity(app, mcp, {
      method: "POST",
      path: "/mcp",
      headers: authed,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "parity", version: "0" } },
      },
    }));
  it("POST /mcp tools/list", () =>
    assertParity(app, mcp, { method: "POST", path: "/mcp", headers: authed, body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } }));
  it("POST /mcp tools/call ping", async () => {
    const direct = await assertParity(app, mcp, {
      method: "POST",
      path: "/mcp",
      headers: authed,
      body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ping", arguments: {} } },
    });
    expect(direct.status).toBe(200);
    expect(JSON.stringify(direct.body)).toContain("pong (workspace=bcontext)");
  });
  it("POST /mcp (Accept negotiation)", () =>
    assertParity(app, mcp, {
      method: "POST",
      path: "/mcp",
      headers: { authorization: GOOD_TOKEN },
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    }));
  it("POST /mcp (not JSON-RPC)", () => assertParity(app, mcp, { method: "POST", path: "/mcp", headers: authed, body: "{nope" }));
  // Not the SSE stream: with a valid `Accept: text/event-stream` the response
  // never ends and a snapshot would hang. The negotiation failure is the part
  // that can be compared.
  it("GET /mcp (Accept negotiation)", () => assertParity(app, mcp, { method: "GET", path: "/mcp", headers: { authorization: GOOD_TOKEN } }));

  it("invalid token: 401 with the enriched WWW-Authenticate", async () => {
    const r: ParityRequest = { method: "POST", path: "/mcp", headers: { authorization: BAD_TOKEN, ...MCP_ACCEPT }, body: {} };
    const direct = await assertParity(app, mcp, r);
    expect(direct.status).toBe(401);
    const value = await assertHeaderParity(mcp, r, "www-authenticate");
    expect(value).toContain('resource_metadata="');
  });

  it("POST /mcp/:org/:workspace tools/call ping on the token's own workspace", async () => {
    const direct = await assertParity(app, mcpWorkspace, {
      method: "POST",
      path: "/mcp/acme/bcontext",
      params: { org: "acme", workspace: "bcontext" },
      headers: authed,
      body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ping", arguments: {} } },
    });
    expect(direct.status).toBe(200);
    expect(JSON.stringify(direct.body)).toContain("pong (workspace=bcontext)");
  });
  it("POST /mcp/:org/:workspace on another workspace: 404, not 403", async () => {
    const direct = await assertParity(app, mcpWorkspace, {
      method: "POST",
      path: "/mcp/acme/other",
      params: { org: "acme", workspace: "other" },
      headers: authed,
      body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ping", arguments: {} } },
    });
    expect(direct.status).toBe(404);
    expect(direct.body).toMatchObject({ error: "workspace_not_found" });
  });
});
