import { describe, it, expect } from "vitest";
import { assertSameOrigin } from "./origin-guard";

function makeReq(opts: {
  method: string;
  host?: string;
  origin?: string;
  authorization?: string;
  forwardedHost?: string;
}): Request {
  const headers = new Headers();
  if (opts.host) headers.set("host", opts.host);
  if (opts.forwardedHost) headers.set("x-forwarded-host", opts.forwardedHost);
  if (opts.origin) headers.set("origin", opts.origin);
  if (opts.authorization) headers.set("authorization", opts.authorization);
  return new Request("https://example.com/api/x", {
    method: opts.method,
    headers,
  });
}

describe("assertSameOrigin", () => {
  it("passes on GET regardless of origin", () => {
    const out = assertSameOrigin(makeReq({ method: "GET" }));
    expect(out).toBeNull();
  });

  it("rejects POST with no origin header", () => {
    const out = assertSameOrigin(makeReq({ method: "POST", host: "x.com" }));
    expect(out?.status).toBe(403);
  });

  it("passes when origin host matches request host", () => {
    const out = assertSameOrigin(
      makeReq({ method: "POST", host: "x.com", origin: "https://x.com" }),
    );
    expect(out).toBeNull();
  });

  it("compares against x-forwarded-host when a proxy set it", () => {
    // The Next → API proxy: host is the API's internal address, the browser's
    // host arrives forwarded. Exactly the headers measured on the local stack.
    const out = assertSameOrigin(
      makeReq({
        method: "POST",
        host: "localhost:4000",
        forwardedHost: "localhost:3000",
        origin: "http://localhost:3000",
      }),
    );
    expect(out).toBeNull();
  });

  it("accepts the app origin the API was told to build links for", () => {
    // Production: the browser is on app.example.com, the API answers on
    // api.example.com, and the proxy in front of it forwards its own name.
    // Without this the client's every fetch is a 403 while server actions,
    // which carry no Origin, keep working — a failure that looks like a
    // permissions bug and is not one.
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    try {
      const out = assertSameOrigin(
        makeReq({
          method: "POST",
          host: "api.example.com",
          forwardedHost: "api.example.com",
          origin: "https://app.example.com",
        }),
      );
      expect(out).toBeNull();
    } finally {
      delete process.env.NEXT_PUBLIC_APP_URL;
    }
  });

  it("still refuses a cross-site origin when an app origin is declared", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    try {
      const out = assertSameOrigin(
        makeReq({
          method: "POST",
          host: "api.example.com",
          origin: "https://evil.example",
        }),
      );
      expect(out?.status).toBe(403);
    } finally {
      delete process.env.NEXT_PUBLIC_APP_URL;
    }
  });

  it("still rejects a cross-site origin behind the proxy", () => {
    const out = assertSameOrigin(
      makeReq({
        method: "POST",
        host: "localhost:4000",
        forwardedHost: "localhost:3000",
        origin: "https://evil.example",
      }),
    );
    expect(out?.status).toBe(403);
  });

  it("rejects when origin host differs", () => {
    const out = assertSameOrigin(
      makeReq({
        method: "POST",
        host: "x.com",
        origin: "https://evil.example",
      }),
    );
    expect(out?.status).toBe(403);
  });

  it("bypasses entirely for bearer-token requests", () => {
    const out = assertSameOrigin(
      makeReq({
        method: "POST",
        host: "x.com",
        authorization: "Bearer bctx_live_anything",
      }),
    );
    expect(out).toBeNull();
  });

  it("bypasses for /mcp even without bearer or origin (OAuth-discovery path)", () => {
    const req = new Request("https://example.com/mcp", { method: "POST" });
    expect(assertSameOrigin(req)).toBeNull();
  });

  it("bypasses for the per-workspace MCP endpoint without bearer or origin", () => {
    const req = new Request("https://example.com/mcp/acme/product", { method: "POST" });
    expect(assertSameOrigin(req)).toBeNull();
  });

  it("bypasses for OAuth token endpoint (machine-to-machine, no cookies)", () => {
    const req = new Request("https://example.com/api/oauth/token", {
      method: "POST",
    });
    expect(assertSameOrigin(req)).toBeNull();
  });
});
