import { afterEach, describe, expect, test, vi } from "vitest";
import { purgeErrorTelemetry } from "./retention";
import { HANDLERS } from "@/lib/queue/handlers";
import { QUEUES, QUEUE_ERRORS_RETENTION } from "@/lib/queue/queues";

function client(response: { data?: unknown; error?: { message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue({ data: response.data ?? null, error: response.error ?? null });
  return { rpc } as unknown as Parameters<typeof purgeErrorTelemetry>[0] & { rpc: typeof rpc };
}

afterEach(() => {
  delete process.env.ERRORS_EVENT_RETENTION_DAYS;
  delete process.env.ERRORS_GROUP_RETENTION_DAYS;
});

describe("purgeErrorTelemetry", () => {
  test("calls the SQL function with the default policy and reports the counts", async () => {
    const c = client({ data: [{ events_deleted: 12, groups_deleted: 3 }] });
    const result = await purgeErrorTelemetry(c);

    expect(c.rpc).toHaveBeenCalledWith("purge_error_telemetry", {
      p_event_days: 30,
      p_group_days: 90,
    });
    expect(result).toMatchObject({ events_deleted: 12, groups_deleted: 3 });
  });

  test("the policy is configurable, and nonsense falls back to the default", async () => {
    process.env.ERRORS_EVENT_RETENTION_DAYS = "7";
    process.env.ERRORS_GROUP_RETENTION_DAYS = "not-a-number";
    const c = client({ data: [{ events_deleted: 0, groups_deleted: 0 }] });
    await purgeErrorTelemetry(c);
    expect(c.rpc).toHaveBeenCalledWith("purge_error_telemetry", {
      p_event_days: 7,
      p_group_days: 90,
    });
  });

  // Postgres returns bigints as strings over PostgREST; a count that reaches
  // the log as "12" instead of 12 is a number nobody can compare.
  test("coerces the counts Postgres sends back as text", async () => {
    const c = client({ data: [{ events_deleted: "1200", groups_deleted: "4" }] });
    expect(await purgeErrorTelemetry(c)).toMatchObject({
      events_deleted: 1200,
      groups_deleted: 4,
    });
  });

  // This one runs as a job, not inside somebody's catch block: pg-boss should
  // see the rejection and retry it.
  test("throws when the function fails", async () => {
    const c = client({ error: { message: "permission denied" } });
    await expect(purgeErrorTelemetry(c)).rejects.toThrow(/permission denied/);
  });
});

describe("the retention queue", () => {
  test("is in the catalogue, scheduled daily, with a handler attached", () => {
    const queue = QUEUES.find((q) => q.name === QUEUE_ERRORS_RETENTION);
    expect(queue?.cron).toBe("20 4 * * *");
    expect(HANDLERS[QUEUE_ERRORS_RETENTION]).toBeTypeOf("function");
  });
});
