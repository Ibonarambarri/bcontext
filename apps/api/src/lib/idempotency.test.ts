import { describe, it, expect, beforeEach } from "vitest";
import { getIdempotent, setIdempotent } from "./idempotency";

describe("idempotency cache", () => {
  beforeEach(() => {
    // Reset internal map between tests by overwriting many keys.
    // The module-level store has no clear(); we rely on unique keys per test.
  });

  it("returns null when key has never been set", () => {
    expect(getIdempotent(`unknown:${Math.random()}`)).toBeNull();
  });

  it("returns the cached entry within TTL", () => {
    const key = `t1:${Math.random()}`;
    setIdempotent(key, 201, { id: "abc" });
    const hit = getIdempotent(key);
    expect(hit).not.toBeNull();
    expect(hit?.status).toBe(201);
    expect(hit?.body).toEqual({ id: "abc" });
  });

  it("overwrites the entry on a second set for the same key", () => {
    const key = `t2:${Math.random()}`;
    setIdempotent(key, 200, { v: 1 });
    setIdempotent(key, 200, { v: 2 });
    expect(getIdempotent(key)?.body).toEqual({ v: 2 });
  });

  it("evicts the oldest entry once MAX_ENTRIES is exceeded", () => {
    // MAX_ENTRIES is 200 internally. Push 210 distinct keys; the first should
    // be evicted while the latest remain.
    const prefix = `evict:${Math.random()}:`;
    for (let i = 0; i < 210; i++) setIdempotent(`${prefix}${i}`, 200, i);
    expect(getIdempotent(`${prefix}0`)).toBeNull();
    expect(getIdempotent(`${prefix}209`)?.body).toBe(209);
  });
});
