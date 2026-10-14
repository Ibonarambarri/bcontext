import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildReport,
  createErrorReporter,
  describeError,
  redactContext,
} from "./error-report.js";
import { ErrorReportSchema, ERROR_MESSAGE_MAX } from "./errors.js";

const CONFIG = { url: "https://errors.test", key: "k", service: "api" as const };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("describeError", () => {
  test("keeps the name, the message and the stack of a real Error", () => {
    const err = new TypeError("nope");
    const described = describeError(err);
    expect(described.error_type).toBe("TypeError");
    expect(described.message).toBe("nope");
    expect(described.stack).toContain("TypeError: nope");
  });

  test("flattens a cause rather than dropping it", () => {
    const err = new Error("outer", { cause: new Error("inner") });
    expect(describeError(err).cause).toContain("inner");
  });

  // The values that are not Errors are exactly the ones worth recording
  // carefully: a `throw "boom"` in a dependency used to arrive as "{}".
  test("records a thrown string", () => {
    expect(describeError("boom")).toMatchObject({ error_type: "string", message: "boom" });
  });

  test("records a thrown object as JSON", () => {
    expect(describeError({ code: 42 }).message).toBe('{"code":42}');
  });

  test("survives an object that cannot be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeError(circular).message.length).toBeGreaterThan(0);
  });

  test("clamps a message longer than the column", () => {
    const described = describeError(new Error("x".repeat(ERROR_MESSAGE_MAX * 2)));
    expect(described.message.length).toBe(ERROR_MESSAGE_MAX);
  });
});

describe("redactContext", () => {
  test("redacts by key, at any depth", () => {
    const out = redactContext({
      nodeId: "n1",
      apiKey: "sk-live-123",
      nested: { authorization: "Bearer abc", ok: 1 },
    });
    expect(out).toEqual({
      nodeId: "n1",
      apiKey: "[redacted]",
      nested: { authorization: "[redacted]", ok: 1 },
    });
  });
});

describe("buildReport", () => {
  test("produces a body the collector's own schema accepts", () => {
    const report = buildReport(CONFIG, {
      operation: "rest:POST /api/nodes",
      error: new Error("boom"),
      status_code: 500,
      context: { secret: "s", nodeId: "n1" },
    });
    expect(() => ErrorReportSchema.parse(report)).not.toThrow();
    expect(report.operation).toBe("rest:POST /api/nodes");
    expect(report.context).toEqual({ secret: "[redacted]", nodeId: "n1" });
  });

  test("an explicit level wins over the default", () => {
    const report = buildReport(CONFIG, {
      operation: "process:uncaught_exception",
      error: new Error("boom"),
      level: "fatal",
    });
    expect(report.level).toBe("fatal");
  });
});

describe("createErrorReporter", () => {
  test("is a no-op — and says so — when unconfigured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const report = createErrorReporter("api", { url: undefined, key: undefined });
    expect(report.enabled).toBe(false);
    report({ operation: "x", error: new Error("boom") });
    await report.flush({ operation: "x", error: new Error("boom") });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("posts to /ingest with the bearer key", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchSpy);
    const report = createErrorReporter("worker", CONFIG);
    await report.flush({ operation: "job:webhook.drain", error: new Error("boom") });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://errors.test/ingest");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ service: "worker", operation: "job:webhook.drain" });
  });

  // Rule 1 of the module: a reporter that can throw turns one bug into two,
  // and the second one happens inside the error handler.
  test("swallows a collector that is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const report = createErrorReporter("api", CONFIG);
    await expect(
      report.flush({ operation: "x", error: new Error("boom") }),
    ).resolves.toBeUndefined();
    expect(() => report({ operation: "x", error: new Error("boom") })).not.toThrow();
  });
});
