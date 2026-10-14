import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Reading one organization and renaming it. The platform-admin gate runs
 * before the row is touched — the stub records writes, so that is observable.
 */
let sessionUser: { id: string; email: string } | null = null;
const writes: Array<{ table: string; payload: Record<string, unknown> }> = [];

const ORG_ID = "9c2f1a4b-2d3e-4f5a-8b7c-1d2e3f4a5b6c";
const ORG_ROW = { id: ORG_ID, slug: "acme", name: "Acme", created_at: "2026-01-01T00:00:00.000Z" };
const MEMBERS = [
  { id: "u-owner", email: "ana@acme.test", email_confirmed_at: null, last_sign_in_at: null },
];

function makeAdmin() {
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    const rows =
      table === "organizations"
        ? [ORG_ROW]
        : table === "organization_memberships"
          ? [{ user_id: "u-owner", role: "owner", created_at: "2026-01-02T00:00:00.000Z" }]
          : [];
    b.select = () => b;
    b.eq = () => b;
    b.is = () => b;
    b.in = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.update = (payload: Record<string, unknown>) => {
      writes.push({ table, payload });
      return b;
    };
    b.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null });
    return b;
  };
  return {
    from,
    // The spend aggregate (migration 0093); nothing spent in these cases.
    rpc: async () => ({ data: [], error: null }),
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: MEMBERS }, error: null }),
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

import { GET, PATCH } from "./route";

const ctx = (id = ORG_ID) => ({ params: Promise.resolve({ id }) });
const request = (method: string, json?: unknown, id = ORG_ID) =>
  new Request(`http://localhost/api/admin/organizations/${id}`, {
    method,
    headers: { origin: "http://localhost", host: "localhost", "content-type": "application/json" },
    body: json === undefined ? undefined : JSON.stringify(json),
  });

const asAdmin = () => {
  process.env.ADMIN_EMAILS = "root@example.com";
  sessionUser = { id: "u-0", email: "root@example.com" };
};

afterEach(() => {
  sessionUser = null;
  writes.length = 0;
  delete process.env.ADMIN_EMAILS;
});

describe("PATCH /api/admin/organizations/[id]", () => {
  it("refuses a non-admin before any write", async () => {
    process.env.ADMIN_EMAILS = "root@example.com";
    sessionUser = { id: "u-1", email: "ana@example.com" };
    const res = await PATCH(request("PATCH", { name: "Acme Corp" }), ctx());
    expect(res.status).toBe(403);
    expect(writes).toEqual([]);
  });

  it("is a 401 without a session", async () => {
    expect((await PATCH(request("PATCH", { name: "Acme Corp" }), ctx())).status).toBe(401);
    expect(writes).toEqual([]);
  });

  it("renames the organization", async () => {
    asAdmin();
    const res = await PATCH(request("PATCH", { name: "Acme Corp" }), ctx());
    expect(res.status).toBe(200);
    expect(writes).toEqual([{ table: "organizations", payload: { name: "Acme Corp" } }]);
  });

  it("rejects an empty body and a malformed id", async () => {
    asAdmin();
    expect((await PATCH(request("PATCH", {}), ctx())).status).toBe(400);
    expect((await PATCH(request("PATCH", { name: "Acme Corp" }, "nope"), ctx("nope"))).status).toBe(400);
    expect(writes).toEqual([]);
  });
});

describe("GET /api/admin/organizations/[id]", () => {
  it("refuses a non-admin", async () => {
    process.env.ADMIN_EMAILS = "root@example.com";
    sessionUser = { id: "u-1", email: "ana@example.com" };
    expect((await GET(request("GET"), ctx())).status).toBe(403);
  });

  it("carries the roster and the AI spend", async () => {
    asAdmin();
    const res = await GET(request("GET"), ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      members: Array<Record<string, unknown>>;
    } & Record<string, unknown>;
    expect(body).toMatchObject({ slug: "acme" });
    // An owner who was invited and never set a password is the commonest way
    // this fails quietly, so the roster says so without a second read.
    expect(body.members[0]).toMatchObject({
      email: "ana@acme.test",
      confirmed: false,
      last_sign_in_at: null,
    });
    // Never called a model: the spend is zero, not absent — "absent" is what
    // an unreadable ledger looks like.
    expect(body.ai_spend).toEqual({
      total_usd: 0,
      total_events: 0,
      last_30d_usd: 0,
      last_30d_events: 0,
      unpriced_events: 0,
    });
  });
});
