import { describe, it, expect } from "vitest";
import { runWithIds, requestId, correlationId, idsFromRequest, annotateRequest, requestAnnotations } from "@bcontext-dev/contract/correlation";

describe("correlation context", () => {
  it("exposes ids inside runWithIds, undefined outside", () => {
    expect(requestId()).toBeUndefined();
    expect(correlationId()).toBeUndefined();
    runWithIds({ requestId: "r1", correlationId: "c1" }, () => {
      expect(requestId()).toBe("r1");
      expect(correlationId()).toBe("c1");
    });
    expect(requestId()).toBeUndefined();
  });

  it("nested runWithIds shadows the parent ids", () => {
    runWithIds({ requestId: "r1", correlationId: "c1" }, () => {
      runWithIds({ requestId: "r2", correlationId: "c2" }, () => {
        expect(requestId()).toBe("r2");
      });
      expect(requestId()).toBe("r1");
    });
  });

  it("idsFromRequest accepts client-supplied ids and generates the rest", () => {
    const headers = new Headers();
    headers.set("x-request-id", "client-r-1");
    const req = new Request("https://x.com", { headers });
    const out = idsFromRequest(req);
    expect(out.requestId).toBe("client-r-1");
    expect(out.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("generates both when neither header present", () => {
    const out = idsFromRequest(new Request("https://x.com"));
    expect(out.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("collects annotations per request and drops undefined values", () => {
    expect(requestAnnotations()).toEqual({});
    annotateRequest({ tool: "outside" }); // no-op outside a request
    expect(requestAnnotations()).toEqual({});
    runWithIds({ requestId: "r1", correlationId: "c1" }, () => {
      annotateRequest({ tool: "nodes", op: undefined });
      annotateRequest({ principal_kind: "agent", bytes_out: 12 });
      expect(requestAnnotations()).toEqual({ tool: "nodes", principal_kind: "agent", bytes_out: 12 });
      runWithIds({ requestId: "r2", correlationId: "c2" }, () => {
        expect(requestAnnotations()).toEqual({});
      });
    });
    expect(requestAnnotations()).toEqual({});
  });
});
