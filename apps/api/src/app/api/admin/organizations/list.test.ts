import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Reading the customer list.
 *
 * The gate first, as everywhere on this surface. Then the two properties the
 * screen is worthless without: the rows are cut on this side, and the filters
 * are part of the same answer — a search that only saw the current page would
 * report "no such customer" about somebody on page four, and a sort that
 * happened in the browser would rank page two among itself.
 */
let sessionUser: { id: string; email: string } | null = null;
let reads: string[] = [];
/** Every `or=` the route asked Postgres for, and what the invite read was
 *  scoped to — the two places the filtering and the page have to show up. */
let orFilters: string[] = [];
let inFilters: Array<[string, unknown[]]> = [];

const LONG_AGO = "2020-03-11T09:00:00.000Z";
const now = new Date();
const MONTH = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
const THIS_MONTH = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 10),
).toISOString();

/**
 * One customer per rung of the ladder, created oldest-first so that age
 * cannot be mistaken for the sort under test.
 */
const DATA: Record<string, Array<Record<string, unknown>>> = {
  organizations: [
    { id: "org-live", slug: "live", name: "Live", created_at: "2026-05-01T00:00:00.000Z" },
    { id: "org-quiet", slug: "quiet", name: "Quiet", created_at: "2026-04-01T00:00:00.000Z" },
    { id: "org-noagent", slug: "noagent", name: "No Agent", created_at: "2026-03-01T00:00:00.000Z" },
    { id: "org-nosignin", slug: "nosignin", name: "Waiting", created_at: "2026-02-01T00:00:00.000Z" },
    { id: "org-never", slug: "never", name: "Never", created_at: "2026-01-01T00:00:00.000Z" },
  ],
  organization_memberships: [
    { organization_id: "org-live", user_id: "u-live", role: "owner" },
    { organization_id: "org-quiet", user_id: "u-quiet", role: "owner" },
    { organization_id: "org-noagent", user_id: "u-noagent", role: "owner" },
    { organization_id: "org-nosignin", user_id: "u-nosignin", role: "owner" },
  ],
  workspaces: [
    { id: "ws-live", organization_id: "org-live" },
    { id: "ws-quiet", organization_id: "org-quiet" },
    { id: "ws-noagent", organization_id: "org-noagent" },
    { id: "ws-nosignin", organization_id: "org-nosignin" },
    { id: "ws-never", organization_id: "org-never" },
  ],
  workspace_invites: [
    {
      id: "inv-never",
      organization_id: "org-never",
      email: "never@acme.test",
      role: "owner",
      token: "tok-never",
      expires_at: "2030-01-01T00:00:00.000Z",
      accepted_at: null,
      created_at: "2026-01-02T00:00:00.000Z",
      delivery_state: null,
      delivery_at: null,
      delivery_error: null,
    },
  ],
  agent_workspace_access: [
    { agent_id: "a-1", workspace_id: "ws-live", approved_at: LONG_AGO, revoked_at: null },
    { agent_id: "a-2", workspace_id: "ws-quiet", approved_at: LONG_AGO, revoked_at: null },
  ],
  mcp_usage_counters: [{ workspace_id: "ws-live", period: MONTH, calls: 120 }],
  activity: [
    { workspace_id: "ws-live", verb: "created", created_at: THIS_MONTH },
    { workspace_id: "ws-quiet", verb: "created", created_at: LONG_AGO },
  ],
  nodes: [{ id: "n-1", workspace_id: "ws-live" }],
};

/** What `admin_ai_spend` answers: the ledger summed per organization. The
 *  window read (a `p_since`) only sees the recent half of Live's spend. */
const AI_SPEND = {
  all: [
    { organization_id: "org-live", events: "40", cost_usd: "1.250000", unpriced_events: "0" },
    { organization_id: "org-quiet", events: "2", cost_usd: "0.000400", unpriced_events: "2" },
  ],
  recent: [{ organization_id: "org-live", events: "10", cost_usd: "0.433519", unpriced_events: "0" }],
};
let rpcCalls: Array<Record<string, unknown>> = [];

const USERS = [
  { id: "u-live", email: "live@acme.test", last_sign_in_at: THIS_MONTH, email_confirmed_at: THIS_MONTH },
  { id: "u-quiet", email: "quiet@quietco.test", last_sign_in_at: LONG_AGO, email_confirmed_at: LONG_AGO },
  { id: "u-noagent", email: "hello@noagent.test", last_sign_in_at: LONG_AGO, email_confirmed_at: LONG_AGO },
  { id: "u-nosignin", email: "waiting@acme.test", last_sign_in_at: null, email_confirmed_at: null },
];

/**
 * Enough of PostgREST to tell filtering-in-the-query from filtering-after-it:
 * the fake applies exactly the clauses it was handed, so a route that cut
 * rows afterwards would be reading rows this never returned.
 */
function makeAdmin() {
  const from = (table: string) => {
    reads.push(table);
    const where: Array<(row: Record<string, unknown>) => boolean> = [];
    let sort: { col: string; asc: boolean } | null = null;
    let slice: [number, number] | null = null;
    let head = false;
    let counted = false;
    const b: Record<string, unknown> = {};

    b.select = (_cols?: string, opts?: { head?: boolean; count?: string }) => {
      head = Boolean(opts?.head);
      counted = Boolean(opts?.count);
      return b;
    };
    b.eq = (col: string, val: unknown) => {
      where.push((r) => r[col] === val);
      return b;
    };
    b.is = (col: string, val: unknown) => {
      where.push((r) => (r[col] ?? null) === val);
      return b;
    };
    b.in = (col: string, vals: unknown[]) => {
      inFilters.push([`${table}.${col}`, vals]);
      where.push((r) => vals.includes(r[col]));
      return b;
    };
    b.gte = (col: string, val: string) => {
      where.push((r) => String(r[col]) >= val);
      return b;
    };
    b.or = (clause: string) => {
      orFilters.push(clause);
      const tests = clause.split(/,(?![^()]*\))/).map(parseClause);
      where.push((r) => tests.some((t) => t(r)));
      return b;
    };
    b.order = (col: string, opts?: { ascending?: boolean }) => {
      sort = { col, asc: opts?.ascending !== false };
      return b;
    };
    b.limit = (n: number) => {
      slice = [0, n];
      return b;
    };
    b.range = (from_: number, to: number) => {
      slice = [from_, to + 1];
      return b;
    };
    const rows = () => {
      let out = (DATA[table] ?? []).filter((r) => where.every((f) => f(r)));
      if (sort) {
        const { col, asc } = sort;
        out = [...out].sort((x, y) =>
          String(x[col]) < String(y[col]) ? (asc ? -1 : 1) : asc ? 1 : -1,
        );
      }
      return slice ? out.slice(slice[0], slice[1]) : out;
    };
    b.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve(
        head
          ? { count: rows().length, error: null }
          : { data: rows(), count: counted ? rows().length : null, error: null },
      );
    return b;
  };
  return {
    from,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, ...args });
      const scope = args.p_organization_ids as string[] | null;
      const rows = (args.p_since ? AI_SPEND.recent : AI_SPEND.all).filter(
        (r) => !scope || scope.includes(r.organization_id),
      );
      return { data: rows, error: null };
    },
    auth: { admin: { listUsers: async () => ({ data: { users: USERS }, error: null }) } },
  };
}

/** `name.ilike.*ac*` / `id.in.(a,b)` — the two shapes the list emits. */
function parseClause(clause: string): (row: Record<string, unknown>) => boolean {
  const [col, op, ...rest] = clause.split(".");
  const value = rest.join(".");
  if (op === "ilike") {
    const needle = value.replaceAll("*", "").toLowerCase();
    return (r) => String(r[col!] ?? "").toLowerCase().includes(needle);
  }
  const ids = value.replace(/^\(|\)$/g, "").split(",");
  return (r) => ids.includes(String(r[col!]));
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

const request = (qs = "") =>
  new Request(`http://localhost/api/admin/organizations${qs}`, {
    headers: { origin: "http://localhost", host: "localhost" },
  });

const asAdmin = () => {
  process.env.ADMIN_EMAILS = "root@example.com";
  sessionUser = { id: "u-0", email: "root@example.com" };
};

interface Body {
  items: Array<Record<string, unknown>>;
  total: number;
  limit: number;
  offset: number;
}
const list = async (qs = ""): Promise<Body> => {
  const res = await GET(request(qs));
  expect(res.status).toBe(200);
  return (await res.json()) as Body;
};

afterEach(() => {
  sessionUser = null;
  reads = [];
  orFilters = [];
  inFilters = [];
  rpcCalls = [];
  delete process.env.ADMIN_EMAILS;
});

describe("GET /api/admin/organizations", () => {
  it("refuses before it reads anything", async () => {
    expect((await GET(request())).status).toBe(401);
    process.env.ADMIN_EMAILS = "root@example.com";
    sessionUser = { id: "u-1", email: "ana@example.com" };
    expect((await GET(request())).status).toBe(403);
    expect(reads).toEqual([]);
  });

  it("ranks the customers worst first, and says which rung each is on", async () => {
    asAdmin();
    const body = await list();
    expect(body.items.map((o) => o.slug)).toEqual([
      "never", // nobody accepted the invitation
      "nosignin", // accepted and never opened
      "noagent", // opened and never connected anything
      "quiet", // connected, and silent this month
      "live",
    ]);
    expect(body.items.map((o) => o.state)).toEqual([
      "never-accepted",
      "never-signed-in",
      "no-agent",
      "quiet",
      "healthy",
    ]);
    // The health figures ride on the row: the ladder is derived from them, so
    // the screen never needs a second read to draw one line.
    expect(body.items[4]).toMatchObject({
      slug: "live",
      mcp_calls: 120,
      writes: 1,
      node_count: 1,
      agent_count: 1,
      last_activity_at: THIS_MONTH,
      owner_emails: ["live@acme.test"],
    });
    // And the link an operator came for is still on the row that has one.
    expect(body.items[0]).toMatchObject({
      pending_invite_count: 1,
      pending_invites: [{ url: "http://localhost:3000/invite/tok-never" }],
    });
  });

  it("carries what each customer's AI calls cost, summed by the database", async () => {
    asAdmin();
    const body = await list();
    const bySlug = Object.fromEntries(body.items.map((o) => [o.slug, o.ai_spend]));
    expect(bySlug.live).toEqual({
      total_usd: 1.25,
      total_events: 40,
      last_30d_usd: 0.433519,
      last_30d_events: 10,
      unpriced_events: 0,
    });
    // Two calls that consumed tokens and cost nothing: a model the price
    // table does not know, which is the hole this column exists to show.
    expect(bySlug.quiet).toMatchObject({ total_usd: 0.0004, unpriced_events: 2 });
    // Never called a model: zero, not missing.
    expect(bySlug.never).toMatchObject({ total_usd: 0, total_events: 0 });
    // Two reads — total and the 30-day window — scoped to the page's ids.
    expect(rpcCalls.map((c) => c.fn)).toEqual(["admin_ai_spend", "admin_ai_spend"]);
    expect(rpcCalls[0]!.p_organization_ids).toEqual(body.items.map((o) => o.id));
  });

  it("cuts the page here, and asks for the expensive rows only for the page", async () => {
    asAdmin();
    const body = await list("?limit=2&offset=1");
    expect(body).toMatchObject({ limit: 2, offset: 1 });
    expect(body.items.map((o) => o.slug)).toEqual(["nosignin", "noagent"]);
    // Five customers match; two are on the page, and the count is of the five.
    expect(body.total).toBe(5);
    // The invitation rows — whole rows, links included — are fetched for the
    // page's organizations and nobody else's.
    expect(inFilters).toContainEqual([
      "workspace_invites.organization_id",
      ["org-nosignin", "org-noagent"],
    ]);
  });

  it("clamps a limit that is not a page", async () => {
    asAdmin();
    expect((await list("?limit=9000&offset=-3")).limit).toBe(200);
    expect((await list("?limit=0")).limit).toBe(50);
  });

  it("searches in the query — name, slug or the owner's address", async () => {
    asAdmin();
    const byName = await list("?q=quiet");
    expect(orFilters[0]).toContain("name.ilike.*quiet*");
    expect(orFilters[0]).toContain("slug.ilike.*quiet*");
    expect(byName.items.map((o) => o.slug)).toEqual(["quiet"]);
    // Not "one page of five, filtered to one": one match, and the total says
    // so — which is what makes page two of a search mean anything.
    expect(byName.total).toBe(1);

    orFilters = [];
    // The address lives in the auth server, which nothing joins to, so it is
    // resolved to organization ids and goes down as part of the same query.
    const byOwner = await list("?q=quietco");
    expect(orFilters[0]).toContain("id.in.(org-quiet)");
    expect(byOwner.items.map((o) => o.slug)).toEqual(["quiet"]);
    expect(byOwner.total).toBe(1);
  });

  it("filters by the same rung the sort ranks by", async () => {
    asAdmin();
    const all = await list();
    // Whoever the ladder called quiet is exactly who the filter returns, and
    // `needs-attention` is everyone the ladder did not call healthy.
    const quiet = all.items.filter((o) => o.state === "quiet").map((o) => o.id);
    expect((await list("?state=quiet")).items.map((o) => o.id)).toEqual(quiet);

    const attention = all.items.filter((o) => o.state !== "healthy").map((o) => o.id);
    const filtered = await list("?state=needs-attention");
    expect(filtered.items.map((o) => o.id)).toEqual(attention);
    expect(filtered.total).toBe(attention.length);
  });

  it("refuses a state nobody defined rather than answering a different question", async () => {
    asAdmin();
    const res = await GET(request("?state=sad"));
    expect(res.status).toBe(400);
    expect(reads).toEqual([]);
  });
});
