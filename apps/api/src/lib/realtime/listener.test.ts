/**
 * The LISTEN side against a fake pool client: what arrives on the channel
 * reaches the hub, except our own echo and what was already delivered; and a
 * dead session is destroyed and replaced, not returned to the pool.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeClient extends EventEmitter {
  query = vi.fn(async (_text: string) => ({ rows: [] }));
  release = vi.fn((_destroy?: boolean) => undefined);
}
const pool = vi.hoisted(() => ({ clients: [] as unknown[], connect: vi.fn() }));
vi.mock("@/lib/queue/db", () => ({
  hasDatabaseUrl: () => true,
  getPool: () => ({ connect: pool.connect }),
}));

import { RealtimeHub, type Peer } from "./hub";
import { startRealtimeListener, type RealtimeListener } from "./listener";
import { CHANNEL, INSTANCE_ID, deliveredIds, encodeNotification } from "./notify";

function peer(key: string): Peer & { frames: unknown[] } {
  const frames: unknown[] = [];
  return { key, frames, send: (t) => frames.push(JSON.parse(t)) };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const event = { kind: "node.updated", payload: { nodeId: "n1" }, from: null, ts: 1 };
const wire = (id: string, origin = "other-instance") => encodeNotification({ id, origin, workspaceId: "w1", event });

let listener: RealtimeListener | null = null;
let clients: FakeClient[] = [];
beforeEach(() => {
  clients = [];
  pool.connect.mockReset();
  pool.connect.mockImplementation(async () => {
    const c = new FakeClient();
    clients.push(c);
    return c;
  });
});
afterEach(async () => {
  await listener?.stop();
  listener = null;
});

describe("realtime listener", () => {
  it("LISTENs on the channel and fans a foreign notification out to the hub", async () => {
    const hub = new RealtimeHub();
    const a = peer("a");
    hub.joinWorkspace("w1", a);
    listener = startRealtimeListener(hub);
    await tick();
    expect(listener.connected).toBe(true);
    expect(clients[0]!.query).toHaveBeenCalledWith(`LISTEN ${CHANNEL}`);
    clients[0]!.emit("notification", { channel: CHANNEL, payload: wire("e1") });
    expect(a.frames).toContainEqual({ t: "event", event });
  });

  it("ignores its own echo, a duplicate, another channel and a bad payload", async () => {
    const hub = new RealtimeHub();
    const a = peer("a");
    hub.joinWorkspace("w1", a);
    listener = startRealtimeListener(hub);
    await tick();
    const c = clients[0]!;
    c.emit("notification", { channel: CHANNEL, payload: wire("own", INSTANCE_ID) });
    deliveredIds.seen("already");
    c.emit("notification", { channel: CHANNEL, payload: wire("already") });
    c.emit("notification", { channel: "something_else", payload: wire("elsewhere") });
    c.emit("notification", { channel: CHANNEL, payload: "{" });
    c.emit("notification", { channel: CHANNEL, payload: wire("twice") });
    c.emit("notification", { channel: CHANNEL, payload: wire("twice") });
    expect(a.frames.filter((f) => (f as { t: string }).t === "event")).toHaveLength(1);
  });

  it("destroys a dead session and checks out a new one after the backoff", async () => {
    const hub = new RealtimeHub();
    listener = startRealtimeListener(hub, { reconnectDelayMs: 10 });
    await tick();
    const first = clients[0]!;
    first.emit("error", new Error("terminating connection"));
    expect(first.release).toHaveBeenCalledWith(true);
    expect(listener.connected).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(listener.connected).toBe(true);
    // The old client's notifications no longer reach anyone.
    const a = peer("a");
    hub.joinWorkspace("w1", a);
    first.emit("notification", { channel: CHANNEL, payload: wire("stale") });
    clients[1]!.emit("notification", { channel: CHANNEL, payload: wire("fresh") });
    expect(a.frames.filter((f) => (f as { t: string }).t === "event")).toHaveLength(1);
  });

  it("retries when the pool itself cannot connect", async () => {
    pool.connect.mockRejectedValueOnce(new Error("pool exhausted"));
    listener = startRealtimeListener(new RealtimeHub(), { reconnectDelayMs: 10 });
    await tick();
    expect(listener.connected).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(listener.connected).toBe(true);
  });

  it("stop() UNLISTENs, returns the client and does not reconnect", async () => {
    listener = startRealtimeListener(new RealtimeHub(), { reconnectDelayMs: 10 });
    await tick();
    const c = clients[0]!;
    await listener.stop();
    expect(c.query).toHaveBeenCalledWith(`UNLISTEN ${CHANNEL}`);
    expect(c.release).toHaveBeenCalledWith();
    c.emit("end");
    await new Promise((r) => setTimeout(r, 30));
    expect(pool.connect).toHaveBeenCalledTimes(1);
    listener = null;
  });
});
