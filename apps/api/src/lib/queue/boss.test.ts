/**
 * Registration and schedule reconciliation. No database: pg-boss is a
 * seam here, which is why boss.ts exports the steps separately from
 * `getBoss()`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@bcontext-dev/contract/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// handlers.ts reaches the whole domain; boss.ts only needs its shape.
vi.mock("./handlers", () => ({ HANDLERS: {} }));

import { applySchedules, registerQueues, registerWorkers } from "./boss";
import type { QueueDefinition } from "./queues";

const catalogue: QueueDefinition[] = [
  { name: "a.drain", options: { retryLimit: 3 }, cron: "* * * * *", description: "a" },
  { name: "b.drain", options: { retryLimit: 1 }, cron: "*/5 * * * *", description: "b" },
  { name: "c.ondemand", options: {}, cron: null, description: "c" },
];

describe("registerQueues", () => {
  it("creates every queue with its options", async () => {
    const createQueue = vi.fn(async () => {});
    await registerQueues({ createQueue } as never, catalogue);
    expect(createQueue).toHaveBeenCalledTimes(3);
    expect(createQueue).toHaveBeenCalledWith("a.drain", { retryLimit: 3 });
  });
});

describe("applySchedules", () => {
  let schedule: ReturnType<typeof vi.fn>;
  let unschedule: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    schedule = vi.fn(async () => {});
    unschedule = vi.fn(async () => {});
  });

  it("schedules only the queues that declare a cron", async () => {
    const getSchedules = vi.fn(async () => []);
    const out = await applySchedules(
      { schedule, unschedule, getSchedules } as never,
      catalogue,
    );
    expect(out.scheduled).toEqual(["a.drain", "b.drain"]);
    expect(schedule).toHaveBeenCalledWith("a.drain", "* * * * *");
    expect(schedule).toHaveBeenCalledWith("b.drain", "*/5 * * * *");
    expect(unschedule).not.toHaveBeenCalled();
  });

  it("removes a schedule that was dropped from the catalogue", async () => {
    const getSchedules = vi.fn(async () => [
      { name: "a.drain" },
      { name: "b.drain" },
      { name: "retired.drain" },
    ]);
    const out = await applySchedules(
      { schedule, unschedule, getSchedules } as never,
      catalogue,
    );
    expect(out.removed).toEqual(["retired.drain"]);
    expect(unschedule).toHaveBeenCalledWith("retired.drain");
  });
});

describe("registerWorkers", () => {
  it("attaches one worker per handler and reports the batch result", async () => {
    const captured: Record<string, () => Promise<unknown>> = {};
    const work = vi.fn(async (name: string, _opts: unknown, handler: () => Promise<unknown>) => {
      captured[name] = handler;
      return `worker-${name}`;
    });
    const ids = await registerWorkers({ work } as never, {
      "a.drain": async () => ({ picked: 2 }),
    });
    expect(ids).toEqual(["worker-a.drain"]);
    await expect(captured["a.drain"]!()).resolves.toEqual({ picked: 2 });
  });

  it("hands the job payload to the handler", async () => {
    const captured: Record<string, (jobs: unknown) => Promise<unknown>> = {};
    const work = vi.fn(async (name: string, _opts: unknown, handler: (jobs: unknown) => Promise<unknown>) => {
      captured[name] = handler;
      return name;
    });
    const seen: unknown[] = [];
    await registerWorkers({ work } as never, {
      "c.ondemand": async (data) => {
        seen.push(data);
        return {};
      },
    });
    await captured["c.ondemand"]!([{ id: "j1", name: "c.ondemand", data: { node_id: "n1" } }]);
    await captured["c.ondemand"]!([{ id: "j2", name: "c.ondemand" }]);
    expect(seen).toEqual([{ node_id: "n1" }, undefined]);
  });

  it("lets a failing handler reject so pg-boss retries the job", async () => {
    const captured: Record<string, () => Promise<unknown>> = {};
    const work = vi.fn(async (name: string, _opts: unknown, handler: () => Promise<unknown>) => {
      captured[name] = handler;
      return name;
    });
    await registerWorkers({ work } as never, {
      "a.drain": async () => {
        throw new Error("upstream down");
      },
    });
    await expect(captured["a.drain"]!()).rejects.toThrow("upstream down");
  });
});
