/**
 * The clock: due computation, the CAS advance, and what one run does. The
 * digest itself is tested from the demo store in `digest.test.ts`; here it
 * is a mock, because the scheduler's job is to call it once, at the right
 * time, for the right workspace.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(async () => "job-1" as string | null),
  publishWeeklyDigest: vi.fn(async () => ({ node: { id: "digest-node" }, created: true })),
  getStorageById: vi.fn(async (id: string) => (id === "ws-1" ? { backend: "demo", workspace: { id: "ws-1", slug: "acme" } } : null)),
  runSkill: vi.fn(async () => ({ output: "skill output", model_used: "m" })),
}));
vi.mock("@/lib/queue/producers", () => ({ enqueue: mocks.enqueue }));
vi.mock("./digest", () => ({ publishWeeklyDigest: mocks.publishWeeklyDigest }));
vi.mock("./run", () => ({ runSkill: mocks.runSkill }));
vi.mock("@/lib/storage", () => ({ getStorageById: mocks.getStorageById }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => { throw new Error("not used"); } }));

import {
  DEFAULT_DIGEST_CRON,
  DEFAULT_DIGEST_SETTINGS,
  DigestSettingsError,
  computeNextRun,
  getDigestSettings,
  runScheduledSkill,
  scheduleDueSkills,
  upsertDigestSettings,
} from "./schedules";

type Row = Record<string, unknown>;

/**
 * supabase-js stand-in for the handful of query shapes the scheduler uses.
 * Filters are applied for real so the CAS on `next_run_at` is exercised.
 */
function fakeClient(rows: Row[]) {
  const calls: string[] = [];
  let counter = 0;
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    let inserted: Row | null = null;
    let limit = Infinity;
    let single: "maybe" | "one" | null = null;
    const run = () => {
      if (inserted) {
        const row = { id: `sched-${++counter}`, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z", last_run_at: null, ...inserted };
        rows.push(row);
        calls.push(`${table}:insert`);
        return { data: single ? { ...row } : [{ ...row }], error: null };
      }
      const matched = rows.filter((r) => filters.every((f) => f(r))).slice(0, limit);
      if (patch) for (const r of matched) Object.assign(r, patch, { updated_at: "2026-09-08T00:00:00.000Z" });
      calls.push(`${table}:${patch ? "update" : "select"}:${matched.length}`);
      const data = matched.map((r) => ({ ...r }));
      if (single === "maybe") return { data: data[0] ?? null, error: null };
      if (single === "one") return data[0] ? { data: data[0], error: null } : { data: null, error: { message: "no rows" } };
      return { data, error: null };
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      update: (p: Row) => { patch = p; return builder; },
      insert: (p: Row) => { inserted = p; return builder; },
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return builder; },
      is: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return builder; },
      in: (k: string, values: unknown[]) => { filters.push((r) => values.includes(r[k])); return builder; },
      or: (expr: string) => {
        const clauses = expr.split(",").map((c) => {
          const [col, op, ...rest] = c.split(".");
          const value = rest.join(".");
          return (r: Row) => (op === "is" && value === "null" ? r[col!] == null : op === "lte" ? String(r[col!]) <= value : false);
        });
        filters.push((r) => clauses.some((c) => c(r)));
        return builder;
      },
      limit: (n: number) => { limit = n; return builder; },
      maybeSingle: () => { single = "maybe"; return builder; },
      single: () => { single = "one"; return builder; },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject),
    };
    return builder;
  }
  return { client: { from } as never, calls };
}

const NOW = new Date("2026-09-14T09:03:00.000Z"); // Monday, three minutes past the default slot
const schedule = (over: Row = {}): Row => ({
  id: "s1",
  workspace_id: "ws-1",
  skill_id: null,
  kind: "digest_weekly",
  cron: DEFAULT_DIGEST_CRON,
  timezone: "UTC",
  enabled: true,
  delivery: { webhook: true },
  last_run_at: null,
  next_run_at: "2026-09-14T09:00:00.000Z",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
  ...over,
});

beforeEach(() => {
  mocks.enqueue.mockClear();
  mocks.enqueue.mockResolvedValue("job-1");
  mocks.publishWeeklyDigest.mockClear();
  mocks.getStorageById.mockClear();
  mocks.runSkill.mockClear();
});

describe("computeNextRun", () => {
  it("is the next slot of the cron in the schedule's timezone", () => {
    expect(computeNextRun({ cron: "0 9 * * 1", timezone: "Europe/Madrid" }, NOW)?.toISOString()).toBe("2026-09-21T07:00:00.000Z");
    expect(computeNextRun({ cron: "nonsense", timezone: "UTC" }, NOW)).toBeNull();
  });
});

describe("scheduleDueSkills", () => {
  it("enqueues a due schedule once and advances its clock first", async () => {
    const rows = [schedule()];
    const { client } = fakeClient(rows);
    const result = await scheduleDueSkills(client, { now: NOW });
    expect(result).toEqual({ scanned: 1, initialised: 0, enqueued: 1, skipped: 0 });
    expect(rows[0]!.next_run_at).toBe("2026-09-21T09:00:00.000Z");
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "skills.run-scheduled",
      { schedule_id: "s1", workspace_id: "ws-1", scheduled_for: "2026-09-14T09:00:00.000Z" },
      { singletonKey: "s1:2026-09-14T09:00:00.000Z" },
    );
    // A second pass in the same window finds nothing due.
    await expect(scheduleDueSkills(client, { now: NOW })).resolves.toEqual({ scanned: 0, initialised: 0, enqueued: 0, skipped: 0 });
  });

  it("gives a freshly enabled schedule a clock without running it", async () => {
    const rows = [schedule({ next_run_at: null })];
    const { client } = fakeClient(rows);
    const result = await scheduleDueSkills(client, { now: NOW });
    expect(result).toEqual({ scanned: 1, initialised: 1, enqueued: 0, skipped: 0 });
    expect(rows[0]!.next_run_at).toBe("2026-09-21T09:00:00.000Z");
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("skips a row another runner advanced between the read and the CAS", async () => {
    const rows = [schedule()];
    const { client } = fakeClient(rows);
    const original = (client as { from: (t: string) => Record<string, unknown> }).from;
    let reads = 0;
    (client as { from: unknown }).from = (table: string) => {
      const builder = original(table);
      if (reads++ === 0) {
        const then = builder.then as (r: (v: unknown) => unknown) => Promise<unknown>;
        builder.then = (resolve: (v: unknown) => unknown) => then((v) => { rows[0]!.next_run_at = "2026-09-21T09:00:00.000Z"; return resolve(v); });
      }
      return builder;
    };
    await expect(scheduleDueSkills(client, { now: NOW })).resolves.toEqual({ scanned: 1, initialised: 0, enqueued: 0, skipped: 1 });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("runs inline when there is no queue runtime", async () => {
    mocks.enqueue.mockResolvedValueOnce(null);
    const rows = [schedule()];
    const { client } = fakeClient(rows);
    await expect(scheduleDueSkills(client, { now: NOW })).resolves.toMatchObject({ enqueued: 1 });
    expect(mocks.publishWeeklyDigest).toHaveBeenCalledTimes(1);
    expect(rows[0]!.last_run_at).toBeTruthy();
  });

  it("leaves disabled and not-yet-due rows alone", async () => {
    const rows = [schedule({ enabled: false }), schedule({ id: "s2", next_run_at: "2026-09-21T09:00:00.000Z" })];
    const { client, calls } = fakeClient(rows);
    await expect(scheduleDueSkills(client, { now: NOW })).resolves.toEqual({ scanned: 0, initialised: 0, enqueued: 0, skipped: 0 });
    expect(calls).toEqual(["skill_schedules:select:0"]);
  });
});

describe("runScheduledSkill", () => {
  it("publishes the digest for the schedule's workspace with its delivery and stamps last_run_at", async () => {
    const rows = [schedule()];
    const { client } = fakeClient(rows);
    const result = await runScheduledSkill(client, { schedule_id: "s1" }, { now: NOW });
    expect(result).toEqual({ schedule_id: "s1", kind: "digest_weekly", workspace_id: "ws-1", node_id: "digest-node", status: "published" });
    expect(mocks.getStorageById).toHaveBeenCalledWith("ws-1");
    expect(mocks.publishWeeklyDigest).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: { id: "ws-1", slug: "acme" } }),
      { now: NOW, delivery: { webhook: true, email: false }, actorKind: "system" },
    );
    expect(rows[0]!.last_run_at).toBe(NOW.toISOString());
  });

  it("skips quietly when the schedule is gone, disabled, or its workspace is", async () => {
    const { client } = fakeClient([schedule({ id: "off", enabled: false }), schedule({ id: "orphan", workspace_id: "ws-gone" })]);
    await expect(runScheduledSkill(client, { schedule_id: "nope" })).resolves.toMatchObject({ status: "skipped", reason: "schedule not found" });
    await expect(runScheduledSkill(client, { schedule_id: "off" })).resolves.toMatchObject({ status: "skipped", reason: "disabled" });
    await expect(runScheduledSkill(client, { schedule_id: "orphan" })).resolves.toMatchObject({ status: "skipped", reason: "workspace not found" });
    await expect(runScheduledSkill(client, { schedule_id: "" })).resolves.toMatchObject({ status: "skipped" });
    expect(mocks.publishWeeklyDigest).not.toHaveBeenCalled();
  });

  it("runs a skill node and keeps its output as a dated doc", async () => {
    const created: Row[] = [];
    const storage = {
      backend: "demo",
      workspace: { id: "ws-1", slug: "acme" },
      getNode: async (id: string) => (id === "skill-1" ? { id, title: "Weekly review", kind: "skill" } : null),
      createNode: async (input: Row) => { created.push(input); return { id: "doc-1", title: input.title }; },
    };
    const { client } = fakeClient([schedule({ id: "sk", kind: "skill", skill_id: "skill-1" })]);
    const result = await runScheduledSkill(client, { schedule_id: "sk" }, { now: NOW, resolveStorage: async () => storage as never });
    expect(result).toMatchObject({ kind: "skill", node_id: "doc-1", status: "published" });
    expect(mocks.runSkill).toHaveBeenCalledWith(storage, { skill_id: "skill-1", input: {} });
    expect(created[0]).toMatchObject({ title: "Weekly review 2026-09-14", kind: "doc", content_md: "skill output", data: expect.objectContaining({ source: "nexo.scheduled_skill", skill_id: "skill-1" }) });
  });
});

describe("digest settings", () => {
  it("reads the defaults when nothing was enabled", async () => {
    const { client } = fakeClient([]);
    await expect(getDigestSettings(client, "ws-1")).resolves.toEqual(DEFAULT_DIGEST_SETTINGS);
  });

  it("creates the schedule on first enable, with the next slot already computed", async () => {
    const rows: Row[] = [];
    const { client } = fakeClient(rows);
    const settings = await upsertDigestSettings(client, "ws-1", { enabled: true, timezone: "Europe/Madrid", delivery: { email: true } }, { now: NOW, createdBy: "u1" });
    expect(settings).toEqual({
      enabled: true,
      cron: DEFAULT_DIGEST_CRON,
      timezone: "Europe/Madrid",
      delivery: { webhook: false, email: true },
      last_run_at: null,
      next_run_at: "2026-09-21T07:00:00.000Z",
    });
    expect(rows[0]).toMatchObject({ workspace_id: "ws-1", kind: "digest_weekly", skill_id: null, created_by: "u1" });
    await expect(getDigestSettings(client, "ws-1")).resolves.toEqual(settings);
  });

  it("keeps the clock on an unrelated edit, resets it when the cron changes, clears it when disabled", async () => {
    const rows = [schedule({ next_run_at: "2026-09-21T09:00:00.000Z" })];
    const { client } = fakeClient(rows);
    const same = await upsertDigestSettings(client, "ws-1", { delivery: { webhook: false } }, { now: NOW });
    expect(same.next_run_at).toBe("2026-09-21T09:00:00.000Z");
    expect(same.delivery).toEqual({ webhook: false, email: false });

    const moved = await upsertDigestSettings(client, "ws-1", { cron: "0 8 * * 5" }, { now: NOW });
    expect(moved.next_run_at).toBe("2026-09-18T08:00:00.000Z");

    const off = await upsertDigestSettings(client, "ws-1", { enabled: false }, { now: NOW });
    expect(off).toMatchObject({ enabled: false, next_run_at: null, cron: "0 8 * * 5" });

    const on = await upsertDigestSettings(client, "ws-1", { enabled: true }, { now: NOW });
    expect(on.next_run_at).toBe("2026-09-18T08:00:00.000Z");
    expect(rows).toHaveLength(1);
  });

  it("refuses a bad cron or timezone before touching the row", async () => {
    const { client, calls } = fakeClient([]);
    await expect(upsertDigestSettings(client, "ws-1", { cron: "every monday" })).rejects.toBeInstanceOf(DigestSettingsError);
    await expect(upsertDigestSettings(client, "ws-1", { timezone: "Mars/Olympus" })).rejects.toMatchObject({ field: "timezone" });
    expect(calls).toEqual([]);
  });
});
