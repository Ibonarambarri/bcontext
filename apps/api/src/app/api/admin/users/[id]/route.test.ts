import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * One person, read the way the platform grants access rather than the way the
 * membership table is shaped.
 *
 * Three things are load-bearing. The platform-admin gate runs before anything
 * is read — the stub records every table it is asked for, so that is
 * observable. A workspace reached because the person owns its organization is
 * in the answer, marked, and appears once even when they also hold a
 * membership there. And an agent nothing has ever used stays in the list with
 * a null stamp, because "never used" is the state an operator came to see.
 */
let sessionUser: { id: string; email: string } | null = null;
const reads: string[] = [];

const USER_ID = "3f6c1b52-0a4d-4e11-9c8a-7b2d5e6f1a90";
const ORG_ID = "9c2f1a4b-2d3e-4f5a-8b7c-1d2e3f4a5b6c";
const WS_JOINED = "11111111-2222-3333-4444-555555555555";
const WS_VIA_ORG = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const AGENT_ID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";

const AUTH_USERS = [
  {
    id: USER_ID,
    email: "ana@acme.test",
    created_at: "2026-01-01T00:00:00.000Z",
    email_confirmed_at: "2026-01-02T00:00:00.000Z",
    last_sign_in_at: "2026-02-01T00:00:00.000Z",
  },
];

const TABLES: Record<string, Array<Record<string, unknown>>> = {
  organization_memberships: [{ organization_id: ORG_ID, role: "owner", user_id: USER_ID }],
  // The person joined one of the organization's two workspaces; the other is
  // reached only through the org role.
  memberships: [{ workspace_id: WS_JOINED, role: "editor", user_id: USER_ID }],
  workspaces: [
    { id: WS_JOINED, slug: "alpha", name: "Alpha", organization_id: ORG_ID },
    { id: WS_VIA_ORG, slug: "beta", name: "Beta", organization_id: ORG_ID },
  ],
  organizations: [{ id: ORG_ID, slug: "acme", name: "Acme" }],
  agents: [
    {
      id: AGENT_ID,
      name: "Codex",
      provider: "codex",
      created_at: "2026-03-01T00:00:00.000Z",
      last_seen_at: null,
      owner_user_id: USER_ID,
    },
  ],
  agent_workspace_access: [],
  api_tokens: [],
  oauth_access_tokens: [],
  user_api_tokens: [],
  activity: [],
};

function makeAdmin() {
  const from = (table: string) => {
    reads.push(table);
    let rows = TABLES[table] ?? [];
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (column: string, value: unknown) => {
      rows = rows.filter((r) => r[column] === value);
      return b;
    };
    b.in = (column: string, values: unknown[]) => {
      rows = rows.filter((r) => values.includes(r[column]));
      return b;
    };
    b.is = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null });
    return b;
  };
  return {
    from,
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: AUTH_USERS }, error: null }),
      },
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => makeAdmin() }));
vi.mock("@/lib/supabase/request", () => ({
  getSupabaseForRequest: () => ({
    auth: { getUser: async () => ({ data: { user: sessionUser } }) },
  }),
}));
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { GET } from "./route";

const ctx = (id = USER_ID) => ({ params: Promise.resolve({ id }) });
const request = (id = USER_ID) =>
  new Request(`http://localhost/api/admin/users/${id}`, {
    headers: { origin: "http://localhost", host: "localhost" },
  });

const asAdmin = () => {
  process.env.ADMIN_EMAILS = "root@example.com";
  sessionUser = { id: "u-0", email: "root@example.com" };
};

interface Body {
  workspaces: Array<{ slug: string; role: string; via_org_role: boolean }>;
  agents: Array<{ id: string; last_used_at: string | null; workspace_count: number }>;
  last_activity_at: string | null;
  orgs: Array<{ slug: string; role: string }>;
  email: string;
  confirmed: boolean;
}

afterEach(() => {
  sessionUser = null;
  reads.length = 0;
  delete process.env.ADMIN_EMAILS;
});

describe("GET /api/admin/users/[id]", () => {
  it("refuses a non-admin before any read", async () => {
    process.env.ADMIN_EMAILS = "root@example.com";
    sessionUser = { id: "u-1", email: "ana@example.com" };
    const res = await GET(request(), ctx());
    expect(res.status).toBe(403);
    expect(reads).toEqual([]);
  });

  it("is a 401 without a session", async () => {
    expect((await GET(request(), ctx())).status).toBe(401);
    expect(reads).toEqual([]);
  });

  it("rejects a malformed id", async () => {
    asAdmin();
    expect((await GET(request("nope"), ctx("nope"))).status).toBe(400);
  });

  it("is a 404 for an id that names nobody", async () => {
    asAdmin();
    const stranger = "00000000-0000-4000-8000-000000000000";
    const res = await GET(request(stranger), ctx(stranger));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
  });

  it("reports the workspace reached through the org role, once and marked", async () => {
    asAdmin();
    const res = await GET(request(), ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body).toMatchObject({ email: "ana@acme.test", confirmed: true });
    expect(body.orgs).toEqual([{ id: ORG_ID, slug: "acme", name: "Acme", role: "owner" }]);
    // Both workspaces of the organization they own, and the one they also
    // joined is not counted twice — the membership is what names its role.
    expect(body.workspaces.map((w) => [w.slug, w.role, w.via_org_role])).toEqual([
      ["alpha", "editor", false],
      ["beta", "owner", true],
    ]);
  });

  it("keeps an agent nothing has ever used, saying so", async () => {
    asAdmin();
    const body = (await (await GET(request(), ctx())).json()) as Body;
    expect(body.agents).toEqual([
      { id: AGENT_ID, name: "Codex", provider: "codex", created_at: "2026-03-01T00:00:00.000Z", last_used_at: null, workspace_count: 0 },
    ]);
    // Signing in is not being around: nothing was ever written.
    expect(body.last_activity_at).toBeNull();
  });
});
