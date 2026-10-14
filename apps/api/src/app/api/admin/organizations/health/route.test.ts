import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The operator's one screen. The gate comes first, as everywhere on this
 * surface, and then the distinction the list exists for: an organization
 * nobody has ever signed into is a different problem from one that is merely
 * quiet, and a row that cannot tell them apart is a row nobody can act on.
 */
let sessionUser: { id: string; email: string } | null = null;
let reads: string[] = [];

// The counters bucket by the current UTC month, so the fixture is built from
// it rather than pinned to a date: a suite that goes red on the first of the
// month teaches everyone to ignore it.
const now = new Date();
const MONTH = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
const THIS_MONTH = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 10),
).toISOString();
const LONG_AGO = "2020-03-11T09:00:00.000Z";
const PREV_MONTH = `${new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
)
  .toISOString()
  .slice(0, 7)}`;

/**
 * Three customers, one of each shape: never opened, opened once and gone
 * quiet, and alive this month.
 */
const DATA: Record<string, Array<Record<string, unknown>>> = {
  organizations: [
    { id: "org-never", slug: "never", name: "Never", created_at: LONG_AGO },
    { id: "org-quiet", slug: "quiet", name: "Quiet", created_at: "2026-02-01T00:00:00.000Z" },
    { id: "org-live", slug: "live", name: "Live", created_at: "2026-01-01T00:00:00.000Z" },
  ],
  organization_memberships: [
    { organization_id: "org-never", user_id: "u-never", role: "owner" },
    { organization_id: "org-quiet", user_id: "u-quiet", role: "owner" },
    { organization_id: "org-live", user_id: "u-live", role: "owner" },
  ],
  workspaces: [
    { id: "ws-never", organization_id: "org-never" },
    { id: "ws-quiet", organization_id: "org-quiet" },
    { id: "ws-live", organization_id: "org-live" },
  ],
  workspace_invites: [
    { organization_id: "org-never", created_at: "2026-08-02T00:00:00.000Z", accepted_at: null },
    { organization_id: "org-never", created_at: "2026-08-20T00:00:00.000Z", accepted_at: null },
  ],
  agent_workspace_access: [
    { agent_id: "a-1", workspace_id: "ws-live", approved_at: "2026-02-02T00:00:00.000Z", revoked_at: null },
    { agent_id: "a-1", workspace_id: "ws-live", approved_at: "2026-05-02T00:00:00.000Z", revoked_at: null },
  ],
  mcp_usage_counters: [
    { workspace_id: "ws-live", period: MONTH, calls: 120 },
    { workspace_id: "ws-live", period: MONTH, calls: 30 },
    // Quiet was busy last month and has read nothing since — the shape the
    // list has to be able to show.
    { workspace_id: "ws-quiet", period: PREV_MONTH, calls: 900 },
  ],
  activity: [
    { workspace_id: "ws-live", verb: "created", created_at: THIS_MONTH },
    { workspace_id: "ws-live", verb: "commented", created_at: THIS_MONTH },
    { workspace_id: "ws-quiet", verb: "created", created_at: LONG_AGO },
  ],
};

const USERS = [
  { id: "u-never", email: "never@acme.test", last_sign_in_at: null },
  { id: "u-quiet", email: "quiet@acme.test", last_sign_in_at: LONG_AGO },
  { id: "u-live", email: "live@acme.test", last_sign_in_at: THIS_MONTH },
];

function makeAdmin() {
  const from = (table: string) => {
    reads.push(table);
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    let head = false;
    const b: Record<string, unknown> = {};
    const rows = () => (DATA[table] ?? []).filter((r) => filters.every((f) => f(r)));
    b.select = (_cols?: string, opts?: { head?: boolean }) => {
      head = Boolean(opts?.head);
      return b;
    };
    b.eq = (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return b;
    };
    b.is = (col: string, val: unknown) => {
      filters.push((r) => (r[col] ?? null) === val);
      return b;
    };
    b.in = (col: string, vals: unknown[]) => {
      filters.push((r) => vals.includes(r[col]));
      return b;
    };
    b.gte = (col: string, val: string) => {
      filters.push((r) => String(r[col]) >= val);
      return b;
    };
    b.order = () => b;
    b.limit = () => b;
    b.range = () => b;
    b.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve(head ? { count: rows().length, error: null } : { data: rows(), error: null });
    return b;
  };
  return {
    from,
    auth: { admin: { listUsers: async () => ({ data: { users: USERS }, error: null }) } },
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

const request = () =>
  new Request("http://localhost/api/admin/organizations/health", {
    headers: { origin: "http://localhost", host: "localhost" },
  });

afterEach(() => {
  sessionUser = null;
  reads = [];
  delete process.env.ADMIN_EMAILS;
});

describe("GET /api/admin/organizations/health", () => {
  it("refuses a non-admin before reading anything", async () => {
    process.env.ADMIN_EMAILS = "root@example.com";
    sessionUser = { id: "u-1", email: "ana@example.com" };
    expect((await GET(request())).status).toBe(403);
    expect(reads).toEqual([]);
  });

  it("is a 401 without a session", async () => {
    expect((await GET(request())).status).toBe(401);
    expect(reads).toEqual([]);
  });

  it("tells a place nobody ever opened from one that has gone quiet", async () => {
    process.env.ADMIN_EMAILS = "root@example.com";
    sessionUser = { id: "u-0", email: "root@example.com" };
    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      organizations: Array<Record<string, unknown>>;
    };
    const bySlug = new Map(body.organizations.map((o) => [o.slug as string, o]));

    // Never opened: two invitations sitting there, nobody has signed in, and
    // there is nothing to date because nothing ever happened.
    expect(bySlug.get("never")).toMatchObject({
      owner_email: "never@acme.test",
      pending_invite_count: 2,
      oldest_pending_invite_at: "2026-08-02T00:00:00.000Z",
      first_sign_in_at: null,
      last_sign_in_at: null,
      last_activity_at: null,
      writes: 0,
    });

    // Quiet: somebody did sign in, and the last thing that happened has a
    // date — older than the month the counters cover, which is the point.
    expect(bySlug.get("quiet")).toMatchObject({
      first_sign_in_at: LONG_AGO,
      last_activity_at: LONG_AGO,
      writes: 0,
      mcp_calls: 0,
      mcp_calls_prev_month: 900,
    });

    // Alive: reads and writes this month, and one agent however many
    // workspaces it reaches.
    expect(bySlug.get("live")).toMatchObject({
      mcp_calls: 150,
      mcp_calls_prev_month: 0,
      writes: 1,
      last_activity_at: THIS_MONTH,
      agent_count: 1,
      first_agent_connected_at: "2026-02-02T00:00:00.000Z",
    });
  });
});
