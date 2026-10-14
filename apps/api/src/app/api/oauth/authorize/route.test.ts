import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who may connect an agent to a workspace, and what the grant is bound to.
 *
 * The consent screen used to ask `memberships` directly, which is one of the
 * two ways in: an owner or admin who joined by invitation has no row there on
 * purpose — their organization role reaches every workspace the company holds,
 * including the ones somebody else creates later. Asking the permission engine
 * is what makes both ways the same answer.
 *
 * The `resource` the screen forwards (RFC 8707) decides the shape of the
 * grant: a workspace's own MCP endpoint makes a workspace-scoped code for
 * exactly that workspace; the root endpoint, or none, keeps the user-scoped
 * code; anything else is not a resource of ours.
 */
type Row = Record<string, unknown>;

const db: Record<string, Row[]> = {};
const issued: Array<Record<string, unknown>> = [];
const agents: Array<Record<string, unknown>> = [];

function table(rows: Row[]) {
  let current = [...rows];
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (col: string, value: unknown) => {
      current = current.filter((r) => r[col] === value);
      return api;
    },
    in: (col: string, values: unknown[]) => {
      current = current.filter((r) => values.includes(r[col]));
      return api;
    },
    is: (col: string, value: unknown) => {
      current = current.filter((r) => r[col] === value);
      return api;
    },
    maybeSingle: async () => ({ data: current[0] ?? null, error: null }),
    single: async () => ({ data: current[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => void) => resolve({ data: current, error: null }),
  };
  return api;
}

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({ from: (name: string) => table(db[name] ?? []) }),
}));
vi.mock("@/lib/supabase/request", () => ({
  getSupabaseForRequest: () => ({
    auth: { getUser: async () => ({ data: { user: { id: signedInUserId } } }) },
  }),
}));
vi.mock("@/lib/auth/oauth", () => ({
  issueAuthorizationCode: async (_admin: unknown, input: Record<string, unknown>) => {
    issued.push(input);
    return "code-1";
  },
}));
vi.mock("@/lib/agents/connections.server", () => ({
  createAgentConnection: async (_admin: unknown, input: Record<string, unknown>) => {
    agents.push(input);
    return "agent-1";
  },
  revokeAgentEverywhere: async () => {},
}));
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
let signedInUserId = "u-owner";

function consent(workspaceIds: string[] = ["ws-1"], resource?: string): Request {
  const form = new URLSearchParams();
  if (resource !== undefined) form.set("resource", resource);
  form.set("client_id", "client-1");
  form.set("redirect_uri", "https://client.test/cb");
  form.set("scope", "nodes:read");
  form.set("code_challenge", "challenge");
  form.set("code_challenge_method", "S256");
  form.set("decision", "allow");
  form.set("agent_name", "Claude Desktop");
  form.set("provider", "claude_code");
  form.set("role", "custom");
  form.append("scopes", "nodes:read");
  for (const id of workspaceIds) form.append("workspace_ids", id);
  return new Request("http://localhost/api/oauth/authorize", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      host: "localhost",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
}

beforeEach(() => {
  signedInUserId = "u-owner";
  db.oauth_clients = [
    {
      client_id: "client-1",
      redirect_uris: ["https://client.test/cb"],
      scope: "nodes:read nodes:write",
      revoked_at: null,
    },
  ];
  db.workspaces = [
    { id: "ws-1", organization_id: ORG, slug: "docs", "organization.slug": "acme" },
    { id: "ws-2", organization_id: ORG, slug: "ops", "organization.slug": "acme" },
  ];
  db.organization_memberships = [
    { organization_id: ORG, user_id: "u-owner", role: "owner" },
    { organization_id: ORG, user_id: "u-outsider", role: "viewer" },
  ];
  db.memberships = [{ user_id: "u-editor", workspace_id: "ws-1", role: "editor" }];
  db.workspace_grants = [];
});

afterEach(() => {
  issued.length = 0;
  agents.length = 0;
});

describe("POST /api/oauth/authorize", () => {
  it("accepts the owner of the company for a workspace somebody else created", async () => {
    const res = await POST(consent());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("code=code-1");
    expect(agents[0]).toMatchObject({ ownerUserId: "u-owner", workspaceIds: ["ws-1"] });
    expect(issued[0]).toMatchObject({ agentId: "agent-1" });
  });

  it("accepts a member of the workspace itself", async () => {
    signedInUserId = "u-editor";
    const res = await POST(consent());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("code=code-1");
  });

  it("refuses somebody the workspace does not reach", async () => {
    signedInUserId = "u-outsider";
    const res = await POST(consent());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_a_member" });
    expect(agents).toHaveLength(0);
  });

  it("refuses when one of the selected workspaces is another tenant's", async () => {
    db.workspaces = [
      { id: "ws-1", organization_id: ORG },
      { id: "ws-elsewhere", organization_id: "22222222-2222-4222-8222-222222222222" },
    ];
    const res = await POST(consent(["ws-1", "ws-elsewhere"]));
    expect(res.status).toBe(403);
    expect(agents).toHaveLength(0);
  });
});

describe("POST /api/oauth/authorize — resource (RFC 8707)", () => {
  it("issues a user-scoped code when the client started from the root endpoint", async () => {
    const res = await POST(consent(["ws-1"], "http://localhost/mcp"));
    expect(res.status).toBe(303);
    expect(issued[0]).toMatchObject({ scopeKind: "user", workspaceId: null });
  });

  it("issues a workspace-scoped code for the workspace the endpoint names", async () => {
    const res = await POST(consent(["ws-1"], "http://localhost/mcp/acme/docs"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("code=code-1");
    expect(agents[0]).toMatchObject({ workspaceIds: ["ws-1"] });
    expect(issued[0]).toMatchObject({ scopeKind: "workspace", workspaceId: "ws-1", agentId: "agent-1" });
  });

  it("refuses a selection that is not exactly the named workspace", async () => {
    for (const ids of [["ws-2"], ["ws-1", "ws-2"]]) {
      const res = await POST(consent(ids, "http://localhost/mcp/acme/docs"));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_request" });
    }
    expect(agents).toHaveLength(0);
  });

  it("answers a workspace that does not exist the same way as a mismatch", async () => {
    const res = await POST(consent(["ws-1"], "http://localhost/mcp/acme/nope"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  it("refuses a resource that is not this server's MCP", async () => {
    for (const resource of ["https://elsewhere.test/mcp/acme/docs", "http://localhost/api/nodes", "nope"]) {
      const res = await POST(consent(["ws-1"], resource));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_target" });
    }
    expect(agents).toHaveLength(0);
  });
});
