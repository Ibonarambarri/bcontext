import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Reading the error list.
 *
 * The gate first, as everywhere on this surface — and before a single row is
 * read. Then the property the screen is built on: with no `status` asked
 * for, the answer is what is still OPEN. A panel whose first page is three
 * months of resolved problems does not answer "what is broken now", and the
 * facet counts have to keep saying how much is hidden so the default reads
 * as a default rather than as a claim that nothing else exists.
 *
 * The filters are the other half: they narrow the whole set before the page
 * is cut, and a value nobody defined is a 400 — answering a typo with the
 * unfiltered list would read as "no such problem exists".
 */
let sessionUser: { id: string; email: string } | null = null;
let reads: string[] = [];
/** Every `or=` the list asked Postgres for — where the search has to show up. */
let orFilters: string[] = [];

const RECENT = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const STALE = new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString();

const group = (over: Record<string, unknown>) => ({
  fingerprint: "fp",
  error_type: "TypeError",
  first_seen: "2026-09-01T00:00:00.000Z",
  event_count: 4,
  users_affected: 1,
  first_release: "r1",
  last_release: "r2",
  resolved_at: null,
  resolved_release: null,
  note: null,
  users_seen: [],
  ...over,
});

const DATA: Record<string, Array<Record<string, unknown>>> = {
  error_groups: [
    group({
      id: "g-new",
      service: "api",
      operation: "mcp.tool:nodes_write",
      level: "error",
      message: "Cannot read properties of undefined",
      status: "new",
      last_seen: "2026-09-06T10:00:00.000Z",
    }),
    group({
      id: "g-ack",
      service: "worker",
      operation: "job:webhook.drain",
      level: "fatal",
      message: "queue stalled",
      status: "ack",
      last_seen: "2026-09-05T10:00:00.000Z",
    }),
    group({
      id: "g-resolved",
      service: "api",
      operation: "rest:POST /api/nodes",
      level: "error",
      message: "old boom",
      status: "resolved",
      last_seen: "2026-09-04T10:00:00.000Z",
    }),
    group({
      id: "g-ignored",
      service: "web",
      operation: "web.route:/w/[org]/[ws]",
      level: "warning",
      message: "hydration noise",
      status: "ignored",
      last_seen: "2026-09-03T10:00:00.000Z",
    }),
  ],
  error_events: [
    { id: "e-1", group_id: "g-new", received_at: RECENT },
    { id: "e-2", group_id: "g-ack", received_at: RECENT },
    { id: "e-3", group_id: "g-resolved", received_at: STALE },
  ],
};

/**
 * Enough of PostgREST to tell filtering-in-the-query from filtering-after-it:
 * the fake applies exactly the clauses it was handed, and counts before it
 * slices, so a route that cut rows afterwards would be reading rows this
 * never returned.
 */
function makeAdmin() {
  const from = (table: string) => {
    reads.push(table);
    const where: Array<(row: Record<string, unknown>) => boolean> = [];
    const sort: Array<{ col: string; asc: boolean }> = [];
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
    b.in = (col: string, vals: unknown[]) => {
      where.push((r) => vals.includes(r[col]));
      return b;
    };
    b.gte = (col: string, val: string) => {
      where.push((r) => String(r[col]) >= val);
      return b;
    };
    b.or = (clause: string) => {
      orFilters.push(clause);
      const tests = clause.split(",").map((c) => {
        const [col, , ...rest] = c.split(".");
        const needle = rest.join(".").replaceAll("*", "").toLowerCase();
        return (r: Record<string, unknown>) =>
          String(r[col!] ?? "").toLowerCase().includes(needle);
      });
      where.push((r) => tests.some((t) => t(r)));
      return b;
    };
    b.order = (col: string, opts?: { ascending?: boolean }) => {
      sort.push({ col, asc: opts?.ascending !== false });
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
    const matched = () => (DATA[table] ?? []).filter((r) => where.every((f) => f(r)));
    const rows = () => {
      let out = [...matched()];
      for (const { col, asc } of [...sort].reverse()) {
        out.sort((x, y) =>
          String(x[col]) < String(y[col]) ? (asc ? -1 : 1) : asc ? 1 : -1,
        );
      }
      return slice ? out.slice(slice[0], slice[1]) : out;
    };
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve(
        head
          ? { count: matched().length, error: null }
          : { data: rows(), count: counted ? matched().length : null, error: null },
      );
    return b;
  };
  return {
    from,
    auth: { admin: { listUsers: async () => ({ data: { users: [] }, error: null }) } },
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

const request = (qs = "") =>
  new Request(`http://localhost/api/admin/errors${qs}`, {
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
  facets: {
    services: Array<{ id: string; count: number }>;
    statuses: Array<{ id: string; count: number }>;
  };
  events24h: number;
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
  delete process.env.ADMIN_EMAILS;
});

describe("GET /api/admin/errors", () => {
  it("refuses before it reads anything", async () => {
    expect((await GET(request())).status).toBe(401);
    process.env.ADMIN_EMAILS = "root@example.com";
    sessionUser = { id: "u-1", email: "ana@example.com" };
    expect((await GET(request())).status).toBe(403);
    expect(reads).toEqual([]);
  });

  it("shows what is still open, most recent first", async () => {
    asAdmin();
    const body = await list();
    expect(body.items.map((g) => g.id)).toEqual(["g-new", "g-ack"]);
    expect(body.total).toBe(2);
    // Every occurrence, sampled ones included — never the number of event
    // rows that survived the sampler.
    expect(body.items[0]).toMatchObject({ event_count: 4, status: "new" });
  });

  it("counts what the default is hiding instead of pretending it is gone", async () => {
    asAdmin();
    const { facets } = await list();
    expect(facets.statuses).toEqual([
      { id: "new", count: 1 },
      { id: "ack", count: 1 },
      { id: "resolved", count: 1 },
      { id: "ignored", count: 1 },
    ]);
    // The service counts do honour the status narrowing: they describe the
    // list as it stands.
    expect(facets.services).toEqual([
      { id: "api", count: 1 },
      { id: "worker", count: 1 },
    ]);
  });

  it("does not let a facet only ever confirm itself", async () => {
    asAdmin();
    const { items, facets } = await list("?service=api");
    expect(items.map((g) => g.id)).toEqual(["g-new"]);
    // Filtered to `api`, the other services are still offerable…
    expect(facets.services.map((s) => s.id)).toEqual(["api", "worker"]);
    // …and the status counts are now about `api` alone.
    expect(facets.statuses).toEqual([
      { id: "new", count: 1 },
      { id: "resolved", count: 1 },
    ]);
  });

  it("counts the last day of occurrences, whatever the list is filtered to", async () => {
    asAdmin();
    expect((await list()).events24h).toBe(2);
    expect((await list("?service=web")).events24h).toBe(2);
  });

  it("narrows the whole set, not the page it would have returned", async () => {
    asAdmin();
    expect((await list("?status=resolved")).items.map((g) => g.id)).toEqual(["g-resolved"]);
    expect((await list("?status=ignored")).items.map((g) => g.id)).toEqual(["g-ignored"]);
    expect((await list("?level=fatal")).items.map((g) => g.id)).toEqual(["g-ack"]);
    // The search reaches Postgres, over the headline and the operation.
    expect((await list("?q=stalled")).items.map((g) => g.id)).toEqual(["g-ack"]);
    expect((await list("?q=nodes_write")).items.map((g) => g.id)).toEqual(["g-new"]);
    expect(orFilters).toContain("message.ilike.*stalled*,operation.ilike.*stalled*");
  });

  it("cuts the page here and clamps what it is asked for", async () => {
    asAdmin();
    const page = await list("?limit=1&offset=1");
    expect(page).toMatchObject({ limit: 1, offset: 1, total: 2 });
    expect(page.items.map((g) => g.id)).toEqual(["g-ack"]);
    expect((await list("?limit=9000")).limit).toBe(200);
  });

  it("refuses a filter nobody defined", async () => {
    asAdmin();
    expect((await GET(request("?service=ftp"))).status).toBe(400);
    expect((await GET(request("?status=fixed"))).status).toBe(400);
    expect((await GET(request("?level=meh"))).status).toBe(400);
    expect(await (await GET(request("?service=ftp"))).json()).toEqual({
      error: "invalid_service",
    });
  });
});
