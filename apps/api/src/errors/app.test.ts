import { describe, expect, it, vi } from "vitest";
import { createErrorsApp } from "./app";
import type { RecordResult } from "./store";
import type { ErrorReport } from "@bcontext-dev/contract/errors";

const KEY = "test-ingest-key";

function report(over: Partial<ErrorReport> = {}): Record<string, unknown> {
  return {
    service: "api",
    operation: "rest:POST /api/nodes",
    message: "cannot read properties of undefined",
    error_type: "TypeError",
    stack: "TypeError: boom\n    at writeNode (/app/src/lib/nodes/write.ts:120:15)",
    ...over,
  };
}

function harness(over: Parameters<typeof createErrorsApp>[0] = {}) {
  const recordEvent = vi.fn(
    async (r: ErrorReport): Promise<RecordResult> => ({
      fingerprint: "f".repeat(32),
      groupId: "00000000-0000-0000-0000-000000000000",
      stored: true,
      eventCount: 1,
    }),
  );
  const app = createErrorsApp({ ingestKey: KEY, recordEvent, ...over });
  const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${KEY}` }) =>
    app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { app, recordEvent, post };
}

describe("auth", () => {
  it("rejects a wrong key", async () => {
    const { post, recordEvent } = harness();
    const res = await post(report(), { authorization: "Bearer nope" });
    expect(res.status).toBe(401);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("rejects a missing header and a non-bearer one", async () => {
    const { post } = harness();
    expect((await post(report(), {})).status).toBe(401);
    expect((await post(report(), { authorization: KEY })).status).toBe(401);
  });

  it("refuses to build without a key at all — an open collector is an open write endpoint", () => {
    const previous = process.env.ERRORS_INGEST_KEY;
    delete process.env.ERRORS_INGEST_KEY;
    try {
      expect(() => createErrorsApp({})).toThrow(/ERRORS_INGEST_KEY/);
    } finally {
      if (previous !== undefined) process.env.ERRORS_INGEST_KEY = previous;
    }
  });
});

describe("POST /ingest", () => {
  it("accepts a single report and answers 202", async () => {
    const { post, recordEvent } = harness();
    const res = await post(report());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1, stored: 1 });
    expect(recordEvent).toHaveBeenCalledTimes(1);
    // The schema default is applied before the store ever sees the report.
    expect(recordEvent.mock.calls[0]?.[0]?.level).toBe("error");
  });

  it("accepts a batch of three", async () => {
    const { post, recordEvent } = harness();
    const res = await post({
      events: [report(), report({ operation: "job:webhook.drain", service: "worker" }), report()],
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 3, stored: 3 });
    expect(recordEvent).toHaveBeenCalledTimes(3);
  });

  it("reports how many were actually stored when sampling drops one", async () => {
    const { app } = harness();
    void app;
    const recordEvent = vi
      .fn<(r: ErrorReport) => Promise<RecordResult>>()
      .mockResolvedValueOnce({ fingerprint: "a", groupId: "g", stored: true, eventCount: 1 })
      .mockResolvedValueOnce({ fingerprint: "a", groupId: "g", stored: false, eventCount: 2 });
    const sampled = createErrorsApp({ ingestKey: KEY, recordEvent });
    const res = await sampled.request("/ingest", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ events: [report(), report()] }),
    });
    expect(await res.json()).toEqual({ accepted: 2, stored: 1 });
  });

  it("answers 400 for unreadable JSON and for a body that is not a report", async () => {
    const { post, recordEvent } = harness();
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ service: "api" })).status).toBe(400);
    expect((await post({ service: "nope", operation: "x", message: "y" })).status).toBe(400);
    expect((await post({ events: [] })).status).toBe(400);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("still answers 202 when the database is down — a 5xx would make the fleet retry", async () => {
    const recordEvent = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const { post } = harness({ recordEvent });
    const res = await post(report());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1, stored: 0 });
  });

  it("answers 413 for a body over the cap", async () => {
    const { post, recordEvent } = harness();
    const res = await post(JSON.stringify(report({ message: "x".repeat(300 * 1024) })));
    expect(res.status).toBe(413);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("throttles a runaway (service, operation) without touching the database", async () => {
    const { post, recordEvent } = harness({ rateLimitPerMin: 2 });
    expect((await post(report())).status).toBe(202);
    expect((await post(report())).status).toBe(202);
    const third = await post(report());
    expect(third.status).toBe(202);
    expect(await third.json()).toEqual({ accepted: 1, stored: 0, throttled: true });
    expect(recordEvent).toHaveBeenCalledTimes(2);
    // A different operation has its own bucket: one loud endpoint must not
    // silence the rest of the fleet.
    const other = await post(report({ operation: "job:webhook.drain" }));
    expect(await other.json()).toEqual({ accepted: 1, stored: 1 });
  });
});

describe("health", () => {
  it("/healthz answers without touching the database", async () => {
    const pingDb = vi.fn(async () => true);
    const { app } = harness({ pingDb });
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, process: "errors" });
    expect(pingDb).not.toHaveBeenCalled();
  });

  it("/readyz is 200 when the database answers and 503 when it does not", async () => {
    const up = harness({ pingDb: async () => true });
    expect((await up.app.request("/readyz")).status).toBe(200);
    const down = harness({ pingDb: async () => false });
    expect((await down.app.request("/readyz")).status).toBe(503);
  });

  it("stamps x-served-by on every response, including 404", async () => {
    const { app } = harness();
    const ok = await app.request("/healthz");
    expect(ok.headers.get("x-served-by")).toBe("errors");
    const missing = await app.request("/nope");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-served-by")).toBe("errors");
    expect(await missing.json()).toEqual({ error: "not_found", path: "/nope" });
  });
});
