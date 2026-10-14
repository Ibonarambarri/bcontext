/**
 * Covers how a user-scoped token picks a workspace.
 *
 * Two rules meet here. MCP clients authenticate over OAuth and cannot attach
 * a custom header, so a request with no `X-Bcontext-Workspace` must still
 * resolve when the caller reaches exactly one workspace. And a workspace is
 * named `<organization>/<workspace>`: a bare slug is refused rather than
 * resolved, because it names one workspace per organization that chose it.
 *
 * The per-workspace endpoint (`/mcp/<org>/<workspace>`) hands the pair in as
 * `workspaceRef`. For a user token it is the selector; for a workspace token
 * it has to be the token's own workspace, and anything else is a 404 that
 * does not say whether the workspace exists.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// Chainable Supabase admin stub. List queries resolve by awaiting the
// builder itself (PostgrestBuilder is a thenable); single-row lookups go
// through maybeSingle. Same shape as workspace-member.test.ts.
const tableRows: Record<string, unknown[]> = {};
function makeAdmin() {
  const builder = (table: string) => {
    const rows = () => tableRows[table] ?? [];
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.is = () => b;
    b.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
    b.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows(), error: null }).then(resolve);
    return b;
  };
  return { from: (t: string) => builder(t) };
}

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => makeAdmin(),
}));
vi.mock("@/lib/supabase/request", () => ({
  getSupabaseForRequest: () => {
    throw new Error("not configured in tests");
  },
}));

import { resolveAgentWorkspaceOr401, type Actor } from "./require";

const MCP_URL = "https://app.example.com/mcp";

const agentUser = (agentId: string | null): Actor => ({
  kind: "agent_user",
  userId: "u1",
  scopes: [],
  tokenId: "tok-1",
  ...(agentId ? { agentId } : {}),
});

const workspaceToken: Actor = {
  kind: "agent",
  workspaceId: "ws-1",
  scopes: [],
  tokenId: "tok-ws",
  createdBy: null,
  agentId: null,
};

/** A request shaped like an MCP client's: bearer only, no custom headers. */
function bareRequest(url = MCP_URL): Request {
  return new Request(url, { method: "POST" });
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("resolveAgentWorkspaceOr401 — no workspace selector", () => {
  afterEach(() => {
    for (const k of Object.keys(tableRows)) delete tableRows[k];
  });

  it("resolves the single workspace an agent connection can reach", async () => {
    tableRows.agent_workspace_access = [
      {
        workspaces: {
          id: "ws-1",
          slug: "bcontext",
          organization: { slug: "acme" },
        },
      },
    ];
    const out = await resolveAgentWorkspaceOr401(
      bareRequest(),
      agentUser("agent-1"),
    );
    expect(out).toEqual({ workspaceId: "ws-1", slug: "acme/bcontext" });
  });

  it("falls back to memberships for legacy tokens with no agent", async () => {
    tableRows.memberships = [
      { workspaces: { id: "ws-9", slug: "solo", organization: { slug: "acme" } } },
    ];
    const out = await resolveAgentWorkspaceOr401(bareRequest(), agentUser(null));
    expect(out).toEqual({ workspaceId: "ws-9", slug: "acme/solo" });
  });

  it("still demands a selector when the caller is ambiguous, naming the candidates", async () => {
    tableRows.agent_workspace_access = [
      { workspaces: { id: "ws-2", slug: "zeta", organization: { slug: "acme" } } },
      { workspaces: { id: "ws-1", slug: "alpha", organization: { slug: "acme" } } },
    ];
    const out = await resolveAgentWorkspaceOr401(
      bareRequest(),
      agentUser("agent-1"),
    );
    expect(out).toBeInstanceOf(Response);
    const res = out as Response;
    expect(res.status).toBe(400);
    const payload = await body(res);
    expect(payload.error).toBe("workspace_required");
    expect(payload.workspaces).toEqual(["acme/alpha", "acme/zeta"]);
    expect(String(payload.message)).toContain("acme/alpha, acme/zeta");
  });

  it("403s when the connection has no workspace access left", async () => {
    tableRows.agent_workspace_access = [];
    const out = await resolveAgentWorkspaceOr401(
      bareRequest(),
      agentUser("agent-1"),
    );
    expect(out).toBeInstanceOf(Response);
    const res = out as Response;
    expect(res.status).toBe(403);
    expect((await body(res)).error).toBe("forbidden");
  });

  it("prefers an explicit ?workspace= selector over the fallback", async () => {
    tableRows.workspaces = [
      { id: "ws-2", slug: "other", organization: { slug: "acme" } },
    ];
    tableRows.agent_workspace_access = [{ agent_id: "agent-1" }];
    const out = await resolveAgentWorkspaceOr401(
      bareRequest(`${MCP_URL}?workspace=acme/other`),
      agentUser("agent-1"),
    );
    expect(out).toEqual({ workspaceId: "ws-2", slug: "other" });
  });

  it("refuses a bare slug rather than picking an organization for you", async () => {
    tableRows.workspaces = [
      { id: "ws-2", slug: "other", organization: { slug: "acme" } },
    ];
    const out = await resolveAgentWorkspaceOr401(
      bareRequest(`${MCP_URL}?workspace=other`),
      agentUser("agent-1"),
    );
    expect(out).toBeInstanceOf(Response);
    const res = out as Response;
    expect(res.status).toBe(400);
    const payload = await body(res);
    expect(payload.error).toBe("workspace_required");
    expect(String(payload.message)).toContain("<organization>/<workspace>");
  });
});

describe("resolveAgentWorkspaceOr401 — workspace named by the path", () => {
  afterEach(() => {
    for (const k of Object.keys(tableRows)) delete tableRows[k];
  });

  it("resolves a user token by the path, checking membership as for a header", async () => {
    tableRows.workspaces = [{ id: "ws-2", slug: "docs", organization: { slug: "acme" } }];
    tableRows.memberships = [{ user_id: "u1" }];
    const out = await resolveAgentWorkspaceOr401(bareRequest(`${MCP_URL}/acme/docs`), agentUser(null), {
      workspaceRef: "acme/docs",
    });
    expect(out).toEqual({ workspaceId: "ws-2", slug: "docs" });
  });

  it("lets the path win over a header that names another workspace", async () => {
    tableRows.workspaces = [{ id: "ws-2", slug: "docs", organization: { slug: "acme" } }];
    tableRows.agent_workspace_access = [{ agent_id: "agent-1" }];
    const req = new Request(`${MCP_URL}/acme/docs`, {
      method: "POST",
      headers: { "x-bcontext-workspace": "acme/other" },
    });
    const out = await resolveAgentWorkspaceOr401(req, agentUser("agent-1"), { workspaceRef: "acme/docs" });
    expect(out).toEqual({ workspaceId: "ws-2", slug: "docs" });
  });

  it("403s a user token whose person is not a member of the named workspace", async () => {
    tableRows.workspaces = [{ id: "ws-2", slug: "docs", organization: { slug: "acme" } }];
    tableRows.memberships = [];
    const out = await resolveAgentWorkspaceOr401(bareRequest(`${MCP_URL}/acme/docs`), agentUser(null), {
      workspaceRef: "acme/docs",
    });
    expect(out).toBeInstanceOf(Response);
    expect((out as Response).status).toBe(403);
  });

  it("accepts a workspace token on its own workspace's path", async () => {
    tableRows.workspaces = [{ id: "ws-1", slug: "docs", organization: { slug: "acme" } }];
    const out = await resolveAgentWorkspaceOr401(bareRequest(`${MCP_URL}/acme/docs`), workspaceToken, {
      workspaceRef: "acme/docs",
    });
    expect(out).toEqual({ workspaceId: "ws-1", slug: "docs" });
  });

  it("404s a workspace token on any other path, never a 403", async () => {
    tableRows.workspaces = [{ id: "ws-1", slug: "docs", organization: { slug: "acme" } }];
    for (const ref of ["acme/other", "other/docs"]) {
      const out = await resolveAgentWorkspaceOr401(bareRequest(`${MCP_URL}/${ref}`), workspaceToken, {
        workspaceRef: ref,
      });
      expect(out).toBeInstanceOf(Response);
      const res = out as Response;
      expect(res.status).toBe(404);
      const payload = await body(res);
      expect(payload.error).toBe("workspace_not_found");
      expect(String(payload.message)).toContain(ref);
    }
  });

  it("keeps the plain lookup for a workspace token with no path", async () => {
    tableRows.workspaces = [{ id: "ws-1", slug: "docs" }];
    const out = await resolveAgentWorkspaceOr401(bareRequest(), workspaceToken);
    expect(out).toEqual({ workspaceId: "ws-1", slug: "docs" });
  });
});
