import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  nodeUpdated: vi.fn(async () => undefined),
}));
vi.mock("@/lib/activity", () => ({ record: mocks.record }));
vi.mock("@/lib/collab/server-broadcast", () => ({ wsBroadcast: { nodeUpdated: mocks.nodeUpdated } }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => { throw new Error("not used"); } }));

import { archiveStaleDoneTasks } from "./auto-archive";

type Row = { id: string; workspace_id: string; title: string; kind: string; status: string; updated_at: string };

/**
 * A supabase-js stand-in for exactly the two queries the job runs: the
 * stale listing (select/in/eq/lt/order/limit) and the guarded update
 * (update/eq×4/select). Filters are applied for real so the guard is tested.
 */
function fakeClient(nodes: Row[], workspaces: Array<{ id: string; slug: string }>) {
  const calls: string[] = [];
  function from(table: string) {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    let patch: Record<string, unknown> | null = null;
    let limit = Infinity;
    const rows = () => (table === "nodes" ? nodes : workspaces) as unknown as Record<string, unknown>[];
    const run = () => {
      const matched = rows().filter((r) => filters.every((f) => f(r))).slice(0, limit);
      if (patch) for (const r of matched) Object.assign(r, patch);
      calls.push(`${table}:${patch ? "update" : "select"}:${matched.length}`);
      return { data: matched.map((r) => ({ ...r })), error: null };
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      update: (p: Record<string, unknown>) => { patch = p; return builder; },
      in: (k: string, values: unknown[]) => { filters.push((r) => values.includes(r[k])); return builder; },
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return builder; },
      lt: (k: string, v: string) => { filters.push((r) => String(r[k]) < v); return builder; },
      order: () => builder,
      limit: (n: number) => { limit = n; return builder; },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
    };
    return builder;
  }
  return { client: { from } as never, calls };
}

const NOW = new Date("2026-09-08T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe("archiveStaleDoneTasks", () => {
  beforeEach(() => { mocks.record.mockReset(); mocks.nodeUpdated.mockReset(); });

  it("archives done tasks and bugs untouched for 30 days, and nothing else", async () => {
    const nodes: Row[] = [
      { id: "old-task", workspace_id: "ws", title: "Old", kind: "task", status: "done", updated_at: daysAgo(45) },
      { id: "old-bug", workspace_id: "ws", title: "Old bug", kind: "bug", status: "done", updated_at: daysAgo(31) },
      { id: "fresh", workspace_id: "ws", title: "Fresh", kind: "task", status: "done", updated_at: daysAgo(3) },
      { id: "open", workspace_id: "ws", title: "Open", kind: "task", status: "todo", updated_at: daysAgo(90) },
      { id: "doc", workspace_id: "ws", title: "Doc", kind: "doc", status: "done", updated_at: daysAgo(90) },
      { id: "shelved", workspace_id: "ws", title: "Already", kind: "task", status: "archived", updated_at: daysAgo(90) },
    ];
    const { client } = fakeClient(nodes, [{ id: "ws", slug: "acme" }]);
    const result = await archiveStaleDoneTasks(client, { now: NOW });
    expect(result).toEqual({ days: 30, scanned: 2, archived: 2, skipped: 0 });
    expect(nodes.map((n) => `${n.id}:${n.status}`)).toEqual([
      "old-task:archived", "old-bug:archived", "fresh:done", "open:todo", "doc:done", "shelved:archived",
    ]);
    expect(mocks.record).toHaveBeenCalledTimes(2);
    expect(mocks.record).toHaveBeenCalledWith("acme", "update", "old-task", "Old", "archived automatically: done for 30 days", expect.objectContaining({ actorKind: "system" }));
    expect(mocks.nodeUpdated).toHaveBeenCalledWith("ws", "old-bug", undefined, { status: "archived" });
  });

  it("honours a custom window and leaves a row edited since the read alone", async () => {
    const nodes: Row[] = [
      { id: "a", workspace_id: "ws", title: "A", kind: "task", status: "done", updated_at: daysAgo(10) },
    ];
    const { client } = fakeClient(nodes, [{ id: "ws", slug: "acme" }]);
    // Someone edits the row between the read and the guarded write.
    const original = (client as { from: (t: string) => unknown }).from;
    let reads = 0;
    (client as { from: unknown }).from = (table: string) => {
      const builder = original(table) as Record<string, unknown>;
      if (table === "nodes" && reads++ === 0) {
        const then = builder.then as (r: (v: unknown) => unknown) => Promise<unknown>;
        builder.then = (resolve: (v: unknown) => unknown) => then((v) => { nodes[0]!.updated_at = daysAgo(0); return resolve(v); });
      }
      return builder;
    };
    const result = await archiveStaleDoneTasks(client, { now: NOW, days: 7 });
    expect(result).toEqual({ days: 7, scanned: 1, archived: 0, skipped: 1 });
    expect(nodes[0]!.status).toBe("done");
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("does nothing, cheaply, when nothing is stale", async () => {
    const { client, calls } = fakeClient([], []);
    await expect(archiveStaleDoneTasks(client, { now: NOW })).resolves.toEqual({ days: 30, scanned: 0, archived: 0, skipped: 0 });
    expect(calls).toEqual(["nodes:select:0"]);
  });
});
