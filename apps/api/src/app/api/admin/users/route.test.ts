import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Reading the people list.
 *
 * The obstacle this file exists to pin down: accounts live in the auth
 * server, which pages its list and offers neither a search nor a join. So
 * the walk is the query, the filters are applied to what it saw, and the
 * payload has to say where the walk stopped — a list that quietly answered a
 * smaller question than the one asked is the failure being guarded against.
 */
let sessionUser: { id: string; email: string } | null = null;
let reads: string[] = [];
/** Every page the route asked the auth server for. */
let pagesAsked: number[] = [];
/** How many accounts exist, for the run at hand. */
let population: Array<Record<string, unknown>> = [];

const LONG_AGO = "2020-03-11T09:00:00.000Z";
const RECENTLY = "2026-08-01T10:00:00.000Z";

const PEOPLE = [
  {
    id: "u-live",
    email: "ana@acme.test",
    created_at: "2026-01-03T00:00:00.000Z",
    last_sign_in_at: RECENTLY,
    email_confirmed_at: LONG_AGO,
  },
  {
    id: "u-never",
    email: "bruno@acme.test",
    created_at: "2026-01-02T00:00:00.000Z",
    last_sign_in_at: null,
    email_confirmed_at: LONG_AGO,
  },
  // No membership anywhere: invited and never arrived, which is exactly the
  // person a list built on `organization_memberships` could not show.
  {
    id: "u-invited",
    email: "carla@other.test",
    created_at: "2026-01-01T00:00:00.000Z",
    last_sign_in_at: null,
    email_confirmed_at: null,
  },
];

const DATA: Record<string, Array<Record<string, unknown>>> = {
  organization_memberships: [
    { user_id: "u-live", organization_id: "org-1", role: "owner" },
    { user_id: "u-never", organization_id: "org-1", role: "viewer" },
  ],
  organizations: [{ id: "org-1", slug: "acme", name: "Acme" }],
};

function makeAdmin() {
  const from = (table: string) => {
    reads.push(table);
    const b: Record<string, unknown> = {};
    for (const k of ["select", "order", "limit", "eq", "in", "is", "range"]) b[k] = () => b;
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: DATA[table] ?? [], error: null });
    return b;
  };
  return {
    from,
    auth: {
      admin: {
        listUsers: async ({ page, perPage }: { page: number; perPage: number }) => {
          pagesAsked.push(page);
          const start = (page - 1) * perPage;
          return {
            data: { users: population.slice(start, start + perPage) },
            error: null,
          };
        },
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

const request = (qs = "") =>
  new Request(`http://localhost/api/admin/users${qs}`, {
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
  scanned: number;
  cap: number;
  capped: boolean;
}
const list = async (qs = ""): Promise<Body> => {
  const res = await GET(request(qs));
  expect(res.status).toBe(200);
  return (await res.json()) as Body;
};

afterEach(() => {
  sessionUser = null;
  reads = [];
  pagesAsked = [];
  population = [];
  delete process.env.ADMIN_EMAILS;
});

describe("GET /api/admin/users", () => {
  it("refuses before it reads anything", async () => {
    expect((await GET(request())).status).toBe(401);
    process.env.ADMIN_EMAILS = "root@example.com";
    sessionUser = { id: "u-1", email: "ana@example.com" };
    expect((await GET(request())).status).toBe(403);
    expect(reads).toEqual([]);
    expect(pagesAsked).toEqual([]);
  });

  it("lists everyone with where they belong, newest first", async () => {
    asAdmin();
    population = PEOPLE;
    const body = await list();
    expect(body.items.map((u) => u.id)).toEqual(["u-live", "u-never", "u-invited"]);
    expect(body.items[0]).toMatchObject({
      email: "ana@acme.test",
      orgs: [{ slug: "acme", role: "owner" }],
    });
    expect(body.total).toBe(3);
  });

  it("cuts the page here and clamps what it is asked for", async () => {
    asAdmin();
    population = PEOPLE;
    const page = await list("?limit=1&offset=1");
    expect(page).toMatchObject({ limit: 1, offset: 1 });
    expect(page.items.map((u) => u.id)).toEqual(["u-never"]);
    // Three people match; one is on the page, and the count is of the three.
    expect(page.total).toBe(3);
    expect((await list("?limit=9000")).limit).toBe(200);
    expect((await list("?limit=nonsense")).limit).toBe(50);
  });

  it("filters the whole scan, not the page it would have returned", async () => {
    asAdmin();
    population = PEOPLE;
    const search = await list("?q=carla");
    expect(search.items.map((u) => u.id)).toEqual(["u-invited"]);
    expect(search.total).toBe(1);

    expect((await list("?organization=org-1")).items.map((u) => u.id)).toEqual([
      "u-live",
      "u-never",
    ]);
    expect((await list("?role=viewer")).items.map((u) => u.id)).toEqual(["u-never"]);
  });

  it("tells the three ways a person can be stuck apart", async () => {
    asAdmin();
    population = PEOPLE;
    expect((await list("?state=active")).items.map((u) => u.id)).toEqual(["u-live"]);
    expect((await list("?state=never-signed-in")).items.map((u) => u.id)).toEqual([
      "u-never",
    ]);
    // No password at all: the invitation worked and they never arrived.
    expect((await list("?state=invited")).items.map((u) => u.id)).toEqual(["u-invited"]);
    expect((await GET(request("?state=lost"))).status).toBe(400);
    expect((await GET(request("?role=wizard"))).status).toBe(400);
  });

  it("says so when the platform has more people than the walk reached", async () => {
    asAdmin();
    population = [];
    const body = await list();
    expect(body).toMatchObject({ scanned: 0, cap: 1000, capped: false });
    // One page, because a short page means the end of the list.
    expect(pagesAsked).toEqual([1]);

    pagesAsked = [];
    population = Array.from({ length: 1400 }, (_, i) => ({
      id: `u-${i}`,
      email: `p${i}@x.io`,
      created_at: "2026-01-01T00:00:00.000Z",
      last_sign_in_at: null,
      email_confirmed_at: null,
    }));
    const capped = await list();
    expect(pagesAsked).toEqual([1, 2, 3, 4, 5]);
    // The walk saw a thousand of the fourteen hundred, and `total` counts
    // matches among those — with `capped` saying that out loud rather than
    // letting the panel print a confident wrong number.
    expect(capped).toMatchObject({ scanned: 1000, cap: 1000, capped: true, total: 1000 });
    expect(capped.items).toHaveLength(50);
  });
});
