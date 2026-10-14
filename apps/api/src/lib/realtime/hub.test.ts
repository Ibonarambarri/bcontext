import { describe, expect, it } from "vitest";
import { RealtimeHub, type Peer } from "./hub";

function peer(key: string): Peer & { frames: unknown[] } {
  const frames: unknown[] = [];
  return { key, frames, send: (t) => frames.push(JSON.parse(t)) };
}

describe("RealtimeHub — workspace rooms", () => {
  it("hands a newcomer the roster and tells the room when presence changes", () => {
    const hub = new RealtimeHub();
    const a = peer("a"), b = peer("b");
    hub.joinWorkspace("w1", a);
    hub.setPresence("w1", "a", { key: "a", userId: "u1", name: "Ana", color: "#f00", pageId: "n1", ts: 1 });
    hub.joinWorkspace("w1", b);
    // b's first frame is the roster with Ana already in it.
    expect(b.frames[0]).toEqual({ t: "presence", peers: [{ presenceKey: "a", key: "a", userId: "u1", name: "Ana", color: "#f00", pageId: "n1", ts: 1 }] });
    hub.setPresence("w1", "b", { key: "b", userId: "u2", name: "Bo", color: "#0f0", pageId: null, ts: 2 });
    // Both see both. This is the thing that has been off in production.
    const last = (p: ReturnType<typeof peer>) => p.frames[p.frames.length - 1] as { peers: unknown[] };
    expect(last(a).peers).toHaveLength(2);
    expect(last(b).peers).toHaveLength(2);
  });

  it("a peer that never sent presence is not on the roster", () => {
    // An agent's socket, or a tab that has not announced yet.
    const hub = new RealtimeHub();
    hub.joinWorkspace("w1", peer("silent"));
    expect(hub.roster("w1")).toEqual([]);
  });

  it("leaving removes the peer and re-fans the roster only if it was visible", () => {
    const hub = new RealtimeHub();
    const a = peer("a"), b = peer("b");
    hub.joinWorkspace("w1", a); hub.joinWorkspace("w1", b);
    hub.setPresence("w1", "b", { key: "b", userId: "u2", name: "Bo", color: "#0f0", pageId: null, ts: 2 });
    const before = a.frames.length;
    hub.leaveWorkspace("w1", "b");
    expect(a.frames.length).toBe(before + 1);
    expect(hub.roster("w1")).toEqual([]);
    hub.leaveWorkspace("w1", "a");
    expect(hub.stats().workspaces).toBe(0);
  });

  it("events reach everyone but the sender", () => {
    const hub = new RealtimeHub();
    const a = peer("a"), b = peer("b"), c = peer("c");
    for (const p of [a, b, c]) hub.joinWorkspace("w1", p);
    const n = hub.broadcastEvent("w1", { kind: "node.updated", payload: { id: "n1" }, from: "a", ts: 1 }, "a");
    expect(n).toBe(2);
    expect(a.frames.some((f) => (f as { t: string }).t === "event")).toBe(false);
    expect(b.frames.at(-1)).toEqual({ t: "event", event: { kind: "node.updated", payload: { id: "n1" }, from: "a", ts: 1 } });
  });

  it("rooms are isolated", () => {
    const hub = new RealtimeHub();
    const a = peer("a"), b = peer("b");
    hub.joinWorkspace("w1", a); hub.joinWorkspace("w2", b);
    hub.broadcastEvent("w1", { kind: "x", payload: null, from: null, ts: 0 });
    expect(b.frames.some((f) => (f as { t: string }).t === "event")).toBe(false);
  });
});

describe("RealtimeHub — node rooms", () => {
  it("relays frames verbatim to the other editors", () => {
    const hub = new RealtimeHub();
    const a = peer("a"), b = peer("b");
    hub.joinNode("n1", a); hub.joinNode("n1", b);
    const frame = JSON.stringify({ type: "update", clientId: 7, update: "AQI=" });
    expect(hub.relayNode("n1", frame, "a")).toBe(1);
    expect(b.frames).toEqual([{ type: "update", clientId: 7, update: "AQI=" }]);
    expect(a.frames).toEqual([]);
  });

  it("an empty room is dropped", () => {
    const hub = new RealtimeHub();
    hub.joinNode("n1", peer("a"));
    hub.leaveNode("n1", "a");
    expect(hub.stats().nodeRooms).toBe(0);
  });
});
