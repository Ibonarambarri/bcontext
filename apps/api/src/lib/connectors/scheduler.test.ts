import { describe, expect, it, vi } from "vitest";

const enqueueFullSync = vi.fn(async () => "job-1");
vi.mock("./runtime", () => ({ enqueueFullSync: (...args: unknown[]) => enqueueFullSync(...(args as [])) }));

import { nextRunFromConfig, scheduleDueSyncs } from "./scheduler";

interface Row { id: string; workspace_id: string; connector_id: string; status: string; config: Record<string, unknown> }

/** Minimal chainable admin over an in-memory installs table + a jobs count. */
function fakeAdmin(installs: Row[], openJobs = 0) {
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let patch: Record<string, unknown> | null = null;
    const rows = () =>
      installs.filter((r) => filters.every(([k, v]) => (k === "config->>next_run_at" ? r.config.next_run_at === v : (r as never)[k] === v)));
    const builder = {
      select: () => builder,
      eq: (k: string, v: unknown) => {
        filters.push([k, v]);
        return builder;
      },
      not: () => builder,
      in: () => builder,
      limit: async () => ({ data: rows().filter((r) => r.status === "active" && r.config.cadence), error: null }),
      update: (p: Record<string, unknown>) => {
        patch = p;
        return builder;
      },
      maybeSingle: async () => {
        const hit = rows()[0];
        if (hit && patch) Object.assign(hit, patch);
        return { data: hit ? { id: hit.id } : null };
      },
      then: (resolve: (v: unknown) => void) => {
        if (table === "connector_jobs") return resolve({ count: openJobs });
        const hit = rows();
        if (patch) for (const r of hit) Object.assign(r, patch);
        return resolve({ data: hit, error: null });
      },
    };
    return builder;
  };
  return { from } as never;
}

const now = new Date("2026-09-08T07:00:30Z");
const daily = { mode: "daily", hour: 7 };

describe("cadence scheduler", () => {
  it("computes the next run from the install config", () => {
    expect(nextRunFromConfig({ cadence: daily }, now)?.toISOString()).toBe("2026-09-09T07:00:00.000Z");
    expect(nextRunFromConfig({}, now)).toBeNull();
  });

  it("initialises next_run_at on the first pass without firing", async () => {
    enqueueFullSync.mockClear();
    const rows: Row[] = [{ id: "i1", workspace_id: "w", connector_id: "jira", status: "active", config: { cadence: daily } }];
    const result = await scheduleDueSyncs(fakeAdmin(rows), { now });
    expect(result.initialised).toBe(1);
    expect(rows[0]?.config.next_run_at).toBe("2026-09-09T07:00:00.000Z");
    expect(enqueueFullSync).not.toHaveBeenCalled();
  });

  it("enqueues a full_sync when due and advances the slot", async () => {
    enqueueFullSync.mockClear();
    const rows: Row[] = [{ id: "i1", workspace_id: "w", connector_id: "jira", status: "active", config: { cadence: daily, next_run_at: "2026-09-08T07:00:00.000Z" } }];
    const result = await scheduleDueSyncs(fakeAdmin(rows), { now });
    expect(result.enqueued).toBe(1);
    expect(rows[0]?.config.next_run_at).toBe("2026-09-09T07:00:00.000Z");
    expect(enqueueFullSync).toHaveBeenCalledWith({ workspaceId: "w", connectorId: "jira", installId: "i1", cursor: null });
  });

  it("skips installs that are not due yet or already have a job open", async () => {
    enqueueFullSync.mockClear();
    const future: Row[] = [{ id: "i1", workspace_id: "w", connector_id: "jira", status: "active", config: { cadence: daily, next_run_at: "2026-09-09T07:00:00.000Z" } }];
    expect((await scheduleDueSyncs(fakeAdmin(future), { now })).skipped).toBe(1);
    const busy: Row[] = [{ id: "i2", workspace_id: "w", connector_id: "jira", status: "active", config: { cadence: daily, next_run_at: "2026-09-08T07:00:00.000Z" } }];
    expect((await scheduleDueSyncs(fakeAdmin(busy, 1), { now })).skipped).toBe(1);
    expect(enqueueFullSync).not.toHaveBeenCalled();
  });
});
