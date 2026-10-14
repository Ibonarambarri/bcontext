/**
 * Where an event goes, by what the process has: a hub, a database, neither.
 * The pool and the hub are faked at their module seams; what is asserted is
 * the routing and the payload on the channel, not pg.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  hasDatabaseUrl: vi.fn(() => false),
  query: vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [] })),
}));
vi.mock("@/lib/queue/db", () => ({
  hasDatabaseUrl: db.hasDatabaseUrl,
  getPool: () => ({ query: db.query }),
}));

import { RealtimeHub, installHub, type Peer } from "./hub";
import { CHANNEL, INSTANCE_ID, decodeNotification } from "./notify";
import { publishWorkspaceEvent } from "./publish";

function peer(key: string): Peer & { frames: unknown[] } {
  const frames: unknown[] = [];
  return { key, frames, send: (t) => frames.push(JSON.parse(t)) };
}
const event = { kind: "node.updated", payload: { nodeId: "n1" }, from: null, ts: 1 };
const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));

beforeEach(() => {
  db.hasDatabaseUrl.mockReturnValue(false);
  db.query.mockClear();
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
  delete process.env.API_ORIGIN;
  delete process.env.REALTIME_SECRET;
});
afterEach(() => {
  installHub(null);
  vi.unstubAllGlobals();
});

describe("publishWorkspaceEvent — with the hub (the API process)", () => {
  it("fans out to local sockets synchronously and, without a database, goes no further", async () => {
    const hub = new RealtimeHub();
    installHub(hub);
    const a = peer("a"), b = peer("b");
    hub.joinWorkspace("w1", a); hub.joinWorkspace("w1", b);
    const pending = publishWorkspaceEvent("w1", event, { exceptKey: "a" });
    // Before any await: the sender's tab is skipped, the other one has it.
    expect(b.frames).toContainEqual({ t: "event", event });
    expect(a.frames.some((f) => (f as { t: string }).t === "event")).toBe(false);
    const out = await pending;
    expect(out).toMatchObject({ local: 1, relay: "none" });
    expect(db.query).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("notifies the channel with this instance as origin, after delivering locally", async () => {
    db.hasDatabaseUrl.mockReturnValue(true);
    const hub = new RealtimeHub();
    installHub(hub);
    const a = peer("a");
    hub.joinWorkspace("w1", a);
    const out = await publishWorkspaceEvent("w1", event);
    expect(out).toMatchObject({ local: 1, relay: "notify" });
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, values] = db.query.mock.calls[0]!;
    expect(sql).toMatch(/pg_notify/);
    expect(values![0]).toBe(CHANNEL);
    expect(decodeNotification(values![1] as string)).toEqual({ id: out.id, origin: INSTANCE_ID, workspaceId: "w1", event });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("delivers an id it already delivered to nobody", async () => {
    const hub = new RealtimeHub();
    installHub(hub);
    const a = peer("a");
    hub.joinWorkspace("w1", a);
    const first = await publishWorkspaceEvent("w1", event, { id: "dup-1" });
    const second = await publishWorkspaceEvent("w1", event, { id: "dup-1" });
    expect(first.local).toBe(1);
    expect(second).toMatchObject({ local: 0, relay: "none" });
    expect(a.frames.filter((f) => (f as { t: string }).t === "event")).toHaveLength(1);
  });

  it("keeps an event too large for NOTIFY local and says so", async () => {
    db.hasDatabaseUrl.mockReturnValue(true);
    installHub(new RealtimeHub());
    const out = await publishWorkspaceEvent("w1", { ...event, payload: { blob: "x".repeat(9000) } });
    expect(out.relay).toBe("oversize");
    expect(db.query).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never lets a channel failure escape", async () => {
    db.hasDatabaseUrl.mockReturnValue(true);
    db.query.mockRejectedValueOnce(new Error("connection refused"));
    installHub(new RealtimeHub());
    await expect(publishWorkspaceEvent("w1", event)).resolves.toMatchObject({ relay: "none" });
  });
});

describe("publishWorkspaceEvent — without the hub (the worker)", () => {
  it("uses the channel when there is a database", async () => {
    db.hasDatabaseUrl.mockReturnValue(true);
    process.env.API_ORIGIN = "http://api:4000";
    process.env.REALTIME_SECRET = "s";
    const out = await publishWorkspaceEvent("w1", event);
    expect(out).toMatchObject({ local: 0, relay: "notify" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to the HTTP POST — carrying the id — without a database", async () => {
    process.env.API_ORIGIN = "http://api:4000/";
    process.env.REALTIME_SECRET = "cron";
    const out = await publishWorkspaceEvent("w1", event);
    expect(out).toMatchObject({ local: 0, relay: "http" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit]);
    expect(url).toBe("http://api:4000/realtime/broadcast");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer cron");
    expect(JSON.parse(init.body as string)).toEqual({ id: out.id, workspaceId: "w1", event });
  });

  it("falls back to HTTP when the channel refuses the event", async () => {
    db.hasDatabaseUrl.mockReturnValue(true);
    db.query.mockRejectedValueOnce(new Error("boom"));
    process.env.API_ORIGIN = "http://api:4000";
    process.env.REALTIME_SECRET = "s";
    const out = await publishWorkspaceEvent("w1", event);
    expect(out.relay).toBe("http");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("sends an oversize event over HTTP rather than dropping it", async () => {
    db.hasDatabaseUrl.mockReturnValue(true);
    process.env.API_ORIGIN = "http://api:4000";
    process.env.REALTIME_SECRET = "s";
    const out = await publishWorkspaceEvent("w1", { ...event, payload: { blob: "x".repeat(9000) } });
    expect(out.relay).toBe("http");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("is a no-op with nothing configured", async () => {
    const out = await publishWorkspaceEvent("w1", event);
    expect(out).toMatchObject({ local: 0, relay: "none" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
