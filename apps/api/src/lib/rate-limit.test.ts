import { describe, it, expect, beforeEach } from "vitest";
import { rateLimit, scopeClass, _resetRateLimit } from "./rate-limit";

describe("rateLimit token bucket", () => {
  beforeEach(() => _resetRateLimit());

  it("admits requests up to capacity", () => {
    let allowed = 0;
    for (let i = 0; i < 200; i++) {
      if (rateLimit("k1", "read").ok) allowed += 1;
    }
    // Read capacity is 120; some refill may occur between calls but capacity
    // is the upper bound until time advances meaningfully.
    expect(allowed).toBeGreaterThanOrEqual(120);
    expect(allowed).toBeLessThanOrEqual(125);
  });

  it("denies once the bucket is drained, with Retry-After hint", () => {
    for (let i = 0; i < 121; i++) rateLimit("k2", "read");
    const out = rateLimit("k2", "read");
    expect(out.ok).toBe(false);
    expect(out.retryAfterSec).toBeGreaterThan(0);
  });

  it("scopes are isolated per key", () => {
    for (let i = 0; i < 121; i++) rateLimit("user-a", "read");
    expect(rateLimit("user-b", "read").ok).toBe(true);
  });

  it("scope classes are isolated", () => {
    for (let i = 0; i < 121; i++) rateLimit("u", "read");
    expect(rateLimit("u", "write").ok).toBe(true);
  });
});

describe("scopeClass", () => {
  it("maps known scopes to classes", () => {
    expect(scopeClass("nodes:read")).toBe("read");
    expect(scopeClass("nodes:write")).toBe("write");
    expect(scopeClass("agents:read")).toBe("read");
    expect(scopeClass("agents:write")).toBe("write");
    expect(scopeClass("chat:run")).toBe("chat");
    expect(scopeClass("admin:*")).toBe("write");
  });

  it("falls back to user for unknown / missing scopes", () => {
    expect(scopeClass(undefined)).toBe("user");
    expect(scopeClass("something-else")).toBe("user");
  });
});
