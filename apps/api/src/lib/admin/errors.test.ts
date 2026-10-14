import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The library the panel's two routes are made of, driven directly — which is
 * where the things a route cannot show up: what actually reaches Postgres,
 * and the refusals the routes' own validation would otherwise get to first.
 */
let tables: Record<string, Array<Record<string, unknown>>> = {};
let queries: Array<{ table: string; clauses: string[] }> = [];
let authPages: number[] = [];
let population: Array<{ id: string; email: string }> = [];

const ID = "3f1a6c22-8f61-4a52-9a04-7c1d2b3e4f50";

const seed = () => ({
  error_groups: [
    {
      id: ID,
      fingerprint: "fp-1",
      service: "api",
      operation: "mcp.tool:nodes_write",
      level: "error",
      error_type: "TypeError",
      message: "boom",
      status: "new",
      first_seen: "2026-09-01T00:00:00.000Z",
      last_seen: "2026-09-06T10:00:00.000Z",
      // A bigint arrives from PostgREST as a number, but the column counts
      // occurrences the sampler never stored — so it must never be inferred
      // from the rows in `error_events`.
      event_count: 4_120,
      users_seen: ["u-1"],
      users_affected: 1,
      first_release: "rel-11",
      last_release: "rel-14",
      resolved_at: null,
      resolved_release: null,
      note: "known",
    },
  ],
  error_events: [{ id: "e-1", group_id: ID, received_at: "2026-09-06T10:00:00.000Z", user_id: "u-1", message: "boom", service: "api", operation: "mcp.tool:nodes_write", level: "error" }],
});

function makeAdmin() {
  const from = (table: string) => {
    const entry = { table, clauses: [] as string[] };
    queries.push(entry);
    const where: Array<(row: Record<string, unknown>) => boolean> = [];
    let patch: Record<string, unknown> | null = null;
    const b: Record<string, unknown> = {};
    for (const k of ["select", "order", "limit", "range", "gte"]) b[k] = () => b;
    b.eq = (col: string, val: unknown) => {
      entry.clauses.push(`${col}=${String(val)}`);
      where.push((r) => r[col] === val);
      return b;
    };
    b.in = (col: string, vals: unknown[]) => {
      entry.clauses.push(`${col} in (${vals.join("|")})`);
      where.push((r) => vals.includes(r[col]));
      return b;
    };
    b.or = (clause: string) => {
      entry.clauses.push(`or:${clause}`);
      return b;
    };
    b.update = (payload: Record<string, unknown>) => {
      patch = payload;
      return b;
    };
    const matched = () => (tables[table] ?? []).filter((r) => where.every((f) => f(r)));
    b.maybeSingle = async () => ({ data: matched()[0] ?? null, error: null });
    b.then = (resolve: (v: unknown) => unknown) => {
      if (patch) {
        for (const row of matched()) Object.assign(row, patch);
        return resolve({ data: null, error: null });
      }
      return resolve({ data: matched(), count: matched().length, error: null });
    };
    return b;
  };
  return {
    from,
    auth: {
      admin: {
        listUsers: async ({ page, perPage }: { page: number; perPage: number }) => {
          authPages.push(page);
          const start = (page - 1) * perPage;
          return { data: { users: population.slice(start, start + perPage) }, error: null };
        },
      },
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => makeAdmin() }));
vi.mock("@bcontext-dev/contract/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  AdminErrorError,
  getAdminErrorGroup,
  listAdminErrors,
  updateAdminErrorGroup,
} from "./errors";

const clausesOn = (table: string) => queries.filter((q) => q.table === table).map((q) => q.clauses);

beforeEach(() => {
  tables = seed();
  population = [{ id: "u-1", email: "ana@acme.test" }];
});

afterEach(() => {
  queries = [];
  authPages = [];
});

describe("listAdminErrors", () => {
  it("asks Postgres for the open statuses when none was asked for", async () => {
    await listAdminErrors({});
    // The narrowing is in the query, not a filter over rows already fetched:
    // a page cut after the fact would report the wrong `total`.
    expect(clausesOn("error_groups")[0]).toEqual(["status in (new|ack)"]);
  });

  it("asks for exactly the status it was given", async () => {
    await listAdminErrors({ status: "resolved" });
    expect(clausesOn("error_groups")[0]).toEqual(["status=resolved"]);
  });

  it("sanitises the search box before it becomes an `or=` clause", async () => {
    // A comma or a bracket in the box would not fail — it would silently
    // become a different query, which is what `searchTerm` exists to stop.
    await listAdminErrors({ q: "boom, (x)*" });
    expect(clausesOn("error_groups")[0]?.[0]).toBe(
      "or:message.ilike.*boom   x*,operation.ilike.*boom   x*",
    );
  });

  it("reports the count the group keeps, not the rows the sampler let through", async () => {
    const page = await listAdminErrors({});
    expect(page.items[0]).toMatchObject({ event_count: 4_120, users_affected: 1 });
    expect(page).toMatchObject({ limit: 50, offset: 0, total: 1 });
  });
});

describe("getAdminErrorGroup", () => {
  it("is null for a group that does not exist, rather than a throw", async () => {
    expect(await getAdminErrorGroup("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("gives the id back when the auth walk cannot reach the address", async () => {
    // Past the cap — or with the auth server unwell — the honest answer is
    // the id and a null address, which still identifies the person for a
    // support reply.
    population = [];
    const detail = await getAdminErrorGroup(ID);
    expect(detail?.users).toEqual([{ id: "u-1", email: null, count: 1 }]);
    // One page, because a short page means the end of the list.
    expect(authPages).toEqual([1]);
  });
});

describe("updateAdminErrorGroup", () => {
  it("refuses a status nobody defined, before it writes", async () => {
    await expect(updateAdminErrorGroup(ID, { status: "fixed" })).rejects.toMatchObject({
      status: 400,
      code: "invalid_status",
    });
    expect(tables.error_groups?.[0]?.status).toBe("new");
  });

  it("refuses a patch that changes nothing", async () => {
    await expect(updateAdminErrorGroup(ID, {})).rejects.toBeInstanceOf(AdminErrorError);
  });

  it("is a 404 for an id that names nothing", async () => {
    await expect(
      updateAdminErrorGroup("00000000-0000-4000-8000-000000000000", { status: "ack" }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("leaves the note alone when only the status was asked for", async () => {
    const detail = await updateAdminErrorGroup(ID, { status: "ack" });
    expect(detail).toMatchObject({ status: "ack", note: "known" });
  });
});
