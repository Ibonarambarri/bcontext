/**
 * The codec both ends of the channel share, and the dedupe that lets the
 * channel and the HTTP fallback overlap without a client seeing an event
 * twice. Strings in, strings out — no connection anywhere.
 */
import { describe, expect, it } from "vitest";
import { MAX_NOTIFY_BYTES, SeenIds, decodeNotification, encodeNotification, fitsNotify } from "./notify";

const event = { kind: "node.updated", payload: { nodeId: "n1" }, from: "u1", ts: 1700000000000 };

describe("notification codec", () => {
  it("round-trips an event with its id, origin and workspace", () => {
    const wire = encodeNotification({ id: "e1", origin: "i1", workspaceId: "w1", event });
    expect(decodeNotification(wire)).toEqual({ id: "e1", origin: "i1", workspaceId: "w1", event });
  });

  it("refuses anything that is not what encode writes", () => {
    expect(decodeNotification(undefined)).toBeNull();
    expect(decodeNotification("")).toBeNull();
    expect(decodeNotification("not json")).toBeNull();
    expect(decodeNotification("[]")).toBeNull();
    expect(decodeNotification(JSON.stringify({ v: 2, id: "e", origin: "i", workspaceId: "w", event }))).toBeNull();
    expect(decodeNotification(JSON.stringify({ v: 1, origin: "i", workspaceId: "w", event }))).toBeNull();
    expect(decodeNotification(JSON.stringify({ v: 1, id: "e", origin: "i", event }))).toBeNull();
    expect(decodeNotification(JSON.stringify({ v: 1, id: "e", origin: "i", workspaceId: "w", event: { kind: "x" } }))).toBeNull();
    expect(decodeNotification(JSON.stringify({ v: 1, id: "e", origin: "i", workspaceId: "w", event: { payload: 1 } }))).toBeNull();
  });

  it("normalises a foreign `from` and a missing `ts` instead of passing them through", () => {
    const raw = JSON.stringify({ v: 1, id: "e", origin: "i", workspaceId: "w", event: { kind: "x", payload: null, from: { evil: true } } });
    const n = decodeNotification(raw)!;
    expect(n.event.from).toBeNull();
    expect(typeof n.event.ts).toBe("number");
  });

  it("measures the limit in bytes, not characters", () => {
    expect(fitsNotify("a".repeat(MAX_NOTIFY_BYTES))).toBe(true);
    expect(fitsNotify("a".repeat(MAX_NOTIFY_BYTES + 1))).toBe(false);
    // Three bytes per character: fits by length, not by size.
    expect(fitsNotify("€".repeat(MAX_NOTIFY_BYTES / 3 + 1))).toBe(false);
  });
});

describe("SeenIds", () => {
  it("reports an id the second time and never the first", () => {
    const seen = new SeenIds();
    expect(seen.seen("a")).toBe(false);
    expect(seen.seen("a")).toBe(true);
    expect(seen.seen("b")).toBe(false);
  });

  it("forgets the oldest id past its capacity", () => {
    const seen = new SeenIds(3);
    for (const id of ["a", "b", "c", "d"]) seen.seen(id);
    expect(seen.size).toBe(3);
    expect(seen.seen("a")).toBe(false); // evicted, so it reads as new again
    expect(seen.seen("d")).toBe(true);
  });
});
