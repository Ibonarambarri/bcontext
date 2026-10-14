/**
 * Two things are worth a test here, and they are the two that would fail
 * silently: the shape of the grouping key, and the exemptions.
 *
 * `routePattern` is load-bearing for the whole error panel — get it wrong and
 * every request to a different node id becomes its own "problem", which is not
 * a visible bug, just a table that stops being useful. The exemptions are the
 * mirror image: reporting a reach denial or a missing verb is also invisible,
 * and it drowns the real errors in permission checks doing their job.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { annotateRequest } from "@bcontext-dev/contract/correlation";
import type { Reporter, ReportInput } from "@bcontext-dev/contract/error-report";
import { routePattern, withRoute } from "./route";
import { setApiReporterForTests } from "@/lib/errors/report";
import { ForbiddenError, NodeOutOfReachError } from "@/lib/storage/scoped";

describe("routePattern", () => {
  it("collapses uuid segments", () => {
    expect(
      routePattern("/api/nodes/3f2504e0-4f89-11d3-9a0c-0305e82c3301/tags"),
    ).toBe("/api/nodes/:id/tags");
  });

  it("collapses numeric ids", () => {
    expect(routePattern("/api/webhooks/deliveries/12345/retry")).toBe(
      "/api/webhooks/deliveries/:id/retry",
    );
  });

  it("collapses long opaque tokens", () => {
    expect(routePattern("/api/invites/Xk3n9QpL2mR7tV0zB4cW1/accept")).toBe(
      "/api/invites/:id/accept",
    );
  });

  it("leaves literal segments alone, including long hyphenated ones", () => {
    expect(routePattern("/api/webhooks/deliveries")).toBe(
      "/api/webhooks/deliveries",
    );
    expect(routePattern("/api/integrations")).toBe("/api/integrations");
    expect(routePattern("/api/nodes")).toBe("/api/nodes");
  });

  it("normalizes trailing slashes and the root", () => {
    expect(routePattern("/api/nodes/")).toBe("/api/nodes");
    expect(routePattern("/")).toBe("/");
  });
});

function fakeReporter(): Reporter & { calls: ReportInput[] } {
  const calls: ReportInput[] = [];
  const fn = ((input: ReportInput) => {
    calls.push(input);
  }) as Reporter & { calls: ReportInput[]; enabled: boolean; flush(i: ReportInput): Promise<void> };
  fn.calls = calls;
  fn.enabled = true;
  fn.flush = async (input: ReportInput) => {
    calls.push(input);
  };
  return fn;
}

describe("withRoute error reporting", () => {
  let reporter: ReturnType<typeof fakeReporter>;

  beforeEach(() => {
    reporter = fakeReporter();
    setApiReporterForTests(reporter);
  });
  afterEach(() => {
    setApiReporterForTests(null);
  });

  it("reports an unexpected throw exactly once, with the route pattern", async () => {
    const handler = withRoute(async () => {
      throw new Error("boom");
    });
    const res = await handler(
      new Request("https://api.example.com/api/nodes/3f2504e0-4f89-11d3-9a0c-0305e82c3301", {
        method: "POST",
        headers: { "user-agent": "vitest" },
      }),
    );

    expect(res.status).toBe(500);
    expect(reporter.calls).toHaveLength(1);
    const call = reporter.calls[0]!;
    expect(call.operation).toBe("rest:POST /api/nodes/:id");
    expect(call.status_code).toBe(500);
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/nodes/3f2504e0-4f89-11d3-9a0c-0305e82c3301");
    expect(call.user_agent).toBe("vitest");
    // The request context is ambient, not passed: this is what ties the row
    // to the `request.failed` log line.
    expect(typeof call.request_id).toBe("string");
    expect(typeof call.correlation_id).toBe("string");
  });

  it("does not report a reach denial", async () => {
    const handler = withRoute(async () => {
      throw new NodeOutOfReachError("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
    });
    const res = await handler(new Request("https://api.example.com/api/nodes/abc"));
    expect(res.status).toBe(404);
    expect(reporter.calls).toHaveLength(0);
  });

  it("does not report a missing verb", async () => {
    const handler = withRoute(async () => {
      throw new ForbiddenError("write");
    });
    const res = await handler(new Request("https://api.example.com/api/nodes"));
    expect(res.status).toBe(403);
    expect(reporter.calls).toHaveLength(0);
  });

  it("reports nothing on the happy path", async () => {
    const handler = withRoute(async () => Response.json({ ok: true }));
    const res = await handler(new Request("https://api.example.com/api/nodes"));
    expect(res.status).toBe(200);
    expect(reporter.calls).toHaveLength(0);
  });
});

describe("withRoute request annotations", () => {
  it("puts what the handler annotated on request.completed without touching the fixed fields", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      for (const raw of String(chunk).split("\n")) {
        if (raw.startsWith("{")) lines.push(JSON.parse(raw) as Record<string, unknown>);
      }
      return true;
    }) as never);
    try {
      const handler = withRoute(async () => {
        annotateRequest({ tool: "ping", principal_kind: "agent", bytes_out: 42, status: "spoofed" });
        return new Response("ok");
      });
      const res = await handler(new Request("https://api.example.com/mcp", { method: "POST" }));
      expect(res.status).toBe(200);
      const completed = lines.find((line) => line.event === "request.completed");
      expect(completed).toMatchObject({
        method: "POST",
        path: "/mcp",
        status: 200,
        tool: "ping",
        principal_kind: "agent",
        bytes_out: 42,
      });
      expect(completed?.duration_ms).toBeTypeOf("number");
    } finally {
      spy.mockRestore();
    }
  });
});
