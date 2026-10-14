import { afterEach, describe, expect, it, vi } from "vitest";
import { processDeliveries } from "./worker";

interface MockRow {
  id: string;
  workspace_id: string;
  endpoint_id: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
}

interface MockEndpoint {
  id: string;
  url: string;
  secret_hash: string;
  paused: boolean;
}

/**
 * Stub Supabase client just rich enough to exercise the worker's
 * happy path + edge cases.
 */
function makeAdmin(state: {
  rows: MockRow[];
  endpoints: MockEndpoint[];
  updates: Array<{ id: string; patch: Record<string, unknown> }>;
  fetchOutcomes: Array<{ ok: boolean; status?: number }>;
}) {
  let fetchIdx = 0;
  globalThis.fetch = vi.fn(async () => {
    const o = state.fetchOutcomes[fetchIdx++] ?? { ok: false, status: 500 };
    return {
      status: o.status ?? (o.ok ? 200 : 500),
      ok: o.ok,
    } as Response;
  });

  // Tiny chainable mock; everything terminates at maybeSingle or limit().
  const builder = (table: string) => {
    const ctx: {
      table: string;
      filters: Record<string, unknown>;
      patch?: Record<string, unknown>;
      orderDir?: "asc" | "desc";
      lim?: number;
      casOnStatus?: string;
    } = { table, filters: {} };

    const self = {
      select: () => self,
      eq: (k: string, v: unknown) => {
        if (k === "status" && ctx.patch) {
          ctx.casOnStatus = String(v);
        } else {
          ctx.filters[k] = v;
        }
        return self;
      },
      in: () => self,
      lte: () => self,
      order: () => self,
      limit: (n: number) => {
        ctx.lim = n;
        return Promise.resolve({
          data: state.rows.slice(0, n),
          error: null,
        });
      },
      update: (p: Record<string, unknown>) => {
        ctx.patch = p;
        return self;
      },
      maybeSingle: () => {
        if (ctx.table === "webhook_endpoints") {
          const id = String(ctx.filters.id);
          return Promise.resolve({
            data: state.endpoints.find((e) => e.id === id) ?? null,
            error: null,
          });
        }
        if (ctx.patch) {
          const id = String(ctx.filters.id);
          const row = state.rows.find((r) => r.id === id);
          if (!row) return Promise.resolve({ data: null, error: null });
          // CAS: if locking requested original status, ensure it matches.
          if (
            ctx.casOnStatus !== undefined &&
            row.status !== ctx.casOnStatus
          ) {
            return Promise.resolve({ data: null, error: null });
          }
          state.updates.push({ id, patch: ctx.patch });
          Object.assign(row, ctx.patch);
          return Promise.resolve({ data: { id }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
    };
    return self;
  };

  return { from: builder } as unknown as Parameters<typeof processDeliveries>[0];
}

describe("webhook worker — processDeliveries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns zeros on empty queue", async () => {
    const admin = makeAdmin({ rows: [], endpoints: [], updates: [], fetchOutcomes: [] });
    const r = await processDeliveries(admin);
    expect(r).toEqual({ picked: 0, sent: 0, retried: 0, dead: 0 });
  });

  it("marks a delivery sent on 2xx", async () => {
    const admin = makeAdmin({
      rows: [{
        id: "d1",
        workspace_id: "w1",
        endpoint_id: "e1",
        payload: { foo: "bar" },
        status: "pending",
        attempts: 0,
      }],
      endpoints: [{ id: "e1", url: "https://hook.test/x", secret_hash: "s", paused: false }],
      updates: [],
      fetchOutcomes: [{ ok: true, status: 200 }],
    });
    const r = await processDeliveries(admin);
    expect(r.sent).toBe(1);
    expect(r.retried).toBe(0);
    expect(r.dead).toBe(0);
  });

  it("retries with backoff on a 5xx", async () => {
    const admin = makeAdmin({
      rows: [{
        id: "d2",
        workspace_id: "w1",
        endpoint_id: "e1",
        payload: { foo: "bar" },
        status: "retrying",
        attempts: 1,
      }],
      endpoints: [{ id: "e1", url: "https://hook.test/x", secret_hash: "s", paused: false }],
      updates: [],
      fetchOutcomes: [{ ok: false, status: 503 }],
    });
    const r = await processDeliveries(admin);
    expect(r.retried).toBe(1);
    expect(r.dead).toBe(0);
  });

  it("flips dead after max_attempts", async () => {
    const admin = makeAdmin({
      rows: [{
        id: "d3",
        workspace_id: "w1",
        endpoint_id: "e1",
        payload: { foo: "bar" },
        status: "retrying",
        attempts: 2, // next attempt = 3 = MAX_ATTEMPTS
      }],
      endpoints: [{ id: "e1", url: "https://hook.test/x", secret_hash: "s", paused: false }],
      updates: [],
      fetchOutcomes: [{ ok: false, status: 500 }],
    });
    const r = await processDeliveries(admin);
    expect(r.dead).toBe(1);
    expect(r.retried).toBe(0);
  });

  it("parks delivery when endpoint is paused/missing", async () => {
    const admin = makeAdmin({
      rows: [{
        id: "d4",
        workspace_id: "w1",
        endpoint_id: "e-missing",
        payload: {},
        status: "pending",
        attempts: 0,
      }],
      endpoints: [],
      updates: [],
      fetchOutcomes: [],
    });
    const r = await processDeliveries(admin);
    expect(r.dead).toBe(1);
  });
});
