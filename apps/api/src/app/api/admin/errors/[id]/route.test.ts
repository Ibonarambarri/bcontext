import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One problem, and the two fields an operator owns.
 *
 * What is load-bearing here: resolving does not just move a word, it stamps
 * WHEN it was called fixed and ON WHICH BUILD. That pair is what makes the
 * collector's reopen rule readable later — a group that fires again on a
 * newer release is a fix that did not hold, one that fires again on the same
 * release is a fix that never shipped — and neither reading is available if
 * the row only remembers the word.
 */
let sessionUser: { id: string; email: string } | null = null;
let reads: string[] = [];
let updates: Array<Record<string, unknown>> = [];
let tables: Record<string, Array<Record<string, unknown>>> = {};

const ID = "3f1a6c22-8f61-4a52-9a04-7c1d2b3e4f50";
const MISSING = "00000000-0000-4000-8000-000000000000";

const seed = () => ({
  error_groups: [
    {
      id: ID,
      fingerprint: "fp-1",
      service: "api",
      operation: "mcp.tool:nodes_write",
      level: "error",
      error_type: "TypeError",
      message: "Cannot read properties of undefined",
      status: "new",
      first_seen: "2026-09-01T00:00:00.000Z",
      last_seen: "2026-09-06T10:00:00.000Z",
      event_count: 412,
      users_seen: ["u-1", "u-quiet"],
      users_affected: 2,
      first_release: "rel-11",
      last_release: "rel-14",
      resolved_at: null,
      resolved_release: null,
      note: null,
    },
  ],
  error_events: [
    { id: "e-2", group_id: ID, received_at: "2026-09-06T10:00:00.000Z", user_id: "u-1", message: "boom", service: "api", operation: "mcp.tool:nodes_write", level: "error", stack: "at x", context: { node_id: "n-1" } },
    { id: "e-1", group_id: ID, received_at: "2026-09-05T10:00:00.000Z", user_id: "u-1", message: "boom", service: "api", operation: "mcp.tool:nodes_write", level: "error", stack: null, context: null },
    { id: "e-other", group_id: "other", received_at: "2026-09-06T11:00:00.000Z", user_id: "u-9", message: "elsewhere", service: "web", operation: "web.route:/", level: "error" },
  ],
});

const USERS = [{ id: "u-1", email: "ana@acme.test" }];

function makeAdmin() {
  const from = (table: string) => {
    reads.push(table);
    const where: Array<(row: Record<string, unknown>) => boolean> = [];
    const sort: Array<{ col: string; asc: boolean }> = [];
    let slice: [number, number] | null = null;
    let patch: Record<string, unknown> | null = null;
    const b: Record<string, unknown> = {};
    for (const k of ["select", "or", "in", "gte"]) b[k] = () => b;
    b.eq = (col: string, val: unknown) => {
      where.push((r) => r[col] === val);
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
    b.update = (payload: Record<string, unknown>) => {
      patch = payload;
      return b;
    };
    const matched = () => (tables[table] ?? []).filter((r) => where.every((f) => f(r)));
    const rows = () => {
      let out = [...matched()];
      for (const { col, asc } of [...sort].reverse()) {
        out.sort((x, y) =>
          String(x[col]) < String(y[col]) ? (asc ? -1 : 1) : asc ? 1 : -1,
        );
      }
      return slice ? out.slice(slice[0], slice[1]) : out;
    };
    b.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
    b.then = (resolve: (v: unknown) => unknown) => {
      if (patch) {
        updates.push(patch);
        // Applied, so the read-back the library does afterwards sees what
        // the panel is about to be shown.
        for (const row of matched()) Object.assign(row, patch);
        return resolve({ data: null, error: null });
      }
      return resolve({ data: rows(), count: matched().length, error: null });
    };
    return b;
  };
  return {
    from,
    auth: {
      admin: { listUsers: async () => ({ data: { users: USERS }, error: null }) },
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

const headers = {
  origin: "http://localhost",
  host: "localhost",
  "content-type": "application/json",
};
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const get = (id: string) =>
  GET(new Request(`http://localhost/api/admin/errors/${id}`, { headers }), params(id));

const patch = (id: string, body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/admin/errors/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    }),
    params(id),
  );

const asAdmin = () => {
  process.env.ADMIN_EMAILS = "root@example.com";
  sessionUser = { id: "u-0", email: "root@example.com" };
};

beforeEach(() => {
  tables = seed();
});

afterEach(() => {
  sessionUser = null;
  reads = [];
  updates = [];
  delete process.env.ADMIN_EMAILS;
});

describe("/api/admin/errors/[id]", () => {
  it("refuses before it reads or writes anything", async () => {
    expect((await get(ID)).status).toBe(401);
    expect((await patch(ID, { status: "ack" })).status).toBe(401);
    process.env.ADMIN_EMAILS = "root@example.com";
    sessionUser = { id: "u-1", email: "ana@example.com" };
    expect((await get(ID)).status).toBe(403);
    expect((await patch(ID, { status: "ack" })).status).toBe(403);
    expect(reads).toEqual([]);
    expect(updates).toEqual([]);
  });

  it("answers with the group, its last occurrences and who it reached", async () => {
    asAdmin();
    const res = await get(ID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      event_count: number;
      events: Array<Record<string, unknown>>;
      users: Array<{ id: string; email: string | null; count: number }>;
    };
    expect(body).toMatchObject({ id: ID, event_count: 412 });
    // Newest first, and only this group's.
    expect(body.events.map((e) => e.id)).toEqual(["e-2", "e-1"]);
    expect(body.events[0]).toMatchObject({ stack: "at x", context: { node_id: "n-1" } });
    // The tallies come off the sampled events, so they are floors; somebody
    // remembered in `users_seen` whose rows were all sampled away still shows
    // up, at zero, rather than vanishing.
    expect(body.users).toEqual([
      { id: "u-1", email: "ana@acme.test", count: 2 },
      { id: "u-quiet", email: null, count: 0 },
    ]);
  });

  it("is a 400 for an id that is not one and a 404 for one that names nothing", async () => {
    asAdmin();
    expect((await get("nope")).status).toBe(400);
    expect((await patch("nope", { status: "ack" })).status).toBe(400);
    expect((await get(MISSING)).status).toBe(404);
    const res = await patch(MISSING, { status: "ack" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
    expect(updates).toEqual([]);
  });

  it("seals the moment and the build when a problem is called fixed", async () => {
    asAdmin();
    const res = await patch(ID, { status: "resolved", note: "  bad guard in openWorkspace  " });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "resolved",
      // The build it was last seen on: what a later reopen is compared against.
      resolved_release: "rel-14",
      note: "bad guard in openWorkspace",
    });
    expect(typeof body.resolved_at).toBe("string");
    expect(Number.isNaN(Date.parse(body.resolved_at as string))).toBe(false);
    expect(updates[0]).toMatchObject({ status: "resolved", resolved_release: "rel-14" });
  });

  it("un-resolving drops the claim and keeps the record", async () => {
    asAdmin();
    await patch(ID, { status: "resolved" });
    const res = await patch(ID, { status: "ack" });
    expect(res.status).toBe(200);
    // Same rule as the collector's reopen: the timestamp was a claim about
    // the present and stops being true; the release it was called fixed on is
    // a fact about the past and stays.
    expect(await res.json()).toMatchObject({
      status: "ack",
      resolved_at: null,
      resolved_release: "rel-14",
    });
  });

  it("takes a note back, and refuses a patch that changes nothing", async () => {
    asAdmin();
    await patch(ID, { note: "looking into it" });
    expect(await (await patch(ID, { note: "" })).json()).toMatchObject({ note: null });
    expect(await (await patch(ID, { note: null })).json()).toMatchObject({ note: null });

    const empty = await patch(ID, {});
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error: "invalid_body" });
    const bogus = await patch(ID, { status: "fixed" });
    expect(bogus.status).toBe(400);
  });
});
