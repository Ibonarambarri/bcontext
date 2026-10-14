/**
 * The WebSocket layer, with real sockets on an ephemeral port and the
 * authorisation mocked at the seam `auth.ts` defines. What is tested here is
 * the part the hub tests cannot see: that an unauthorised upgrade never
 * becomes a socket, that frames go where they should, and that a viewer's
 * document updates are dropped on the floor.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";

const auth = vi.hoisted(() => ({
  authenticate: vi.fn(),
  authoriseWorkspace: vi.fn(),
  authoriseNode: vi.fn(),
}));
vi.mock("./auth", () => auth);

import { attachRealtime, type RealtimeServer } from "./server";

let server: Server;
let realtime: RealtimeServer;
let base = "";

beforeAll(async () => {
  server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  realtime = attachRealtime(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  base = `ws://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await realtime.close();
  await new Promise<void>((r) => server.close(() => r()));
});

const GRANT = { workspaceId: "w1", principal: { kind: "user", id: "u1" }, verbs: ["read", "write"], reach: { type: "all" } };

type Client = WebSocket & { frames: Record<string, unknown>[] };

/**
 * The server sends the roster on the upgrade itself, so a listener attached
 * after "open" can miss it. Collect from the first moment.
 */
function open(path: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}${path}`) as Client;
    ws.frames = [];
    ws.on("message", (d) => ws.frames.push(JSON.parse(d.toString())));
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) => reject(new Error(`http ${res.statusCode}`)));
    ws.once("error", reject);
  });
}
/** Wait until the client has at least `n` frames, then return the last. */
async function frame(ws: Client, n: number): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100 && ws.frames.length < n; i++) await new Promise((r) => setTimeout(r, 10));
  if (ws.frames.length < n) throw new Error(`only ${ws.frames.length} frames`);
  return ws.frames[n - 1]!;
}
const settle = () => new Promise((r) => setTimeout(r, 40));

describe("realtime server — handshake", () => {
  it("refuses without a token, before any socket exists", async () => {
    auth.authenticate.mockResolvedValueOnce(null);
    await expect(open("/realtime/ws/w1")).rejects.toThrow(/http 401/);
  });

  it("answers an unreachable workspace as missing, not forbidden", async () => {
    auth.authenticate.mockResolvedValueOnce({ kind: "user", userId: "u1" });
    auth.authoriseWorkspace.mockResolvedValueOnce(null);
    await expect(open("/realtime/ws/w-secret")).rejects.toThrow(/http 404/);
  });

  it("404s an unknown path", async () => {
    await expect(open("/realtime/nope")).rejects.toThrow(/http 404/);
  });
});

describe("realtime server — workspace room", () => {
  it("keeps the roster and fans events out to everyone but the sender", async () => {
    auth.authenticate.mockResolvedValue({ kind: "user", userId: "u1" });
    auth.authoriseWorkspace.mockResolvedValue(GRANT);
    const a = await open("/realtime/ws/w1?token=t");
    expect(await frame(a, 1)).toEqual({ t: "presence", peers: [] });
    a.send(JSON.stringify({ t: "presence", state: { key: "ka", userId: "u1", name: "Ana", color: "#f00", pageId: "n1" } }));
    expect((await frame(a, 2)).peers).toHaveLength(1);

    const b = await open("/realtime/ws/w1?token=t");
    // Presence between people: b sees Ana the moment it joins.
    const hello = await frame(b, 1);
    expect((hello.peers as Array<{ name: string }>)[0]?.name).toBe("Ana");

    a.send(JSON.stringify({ t: "event", event: { kind: "node.updated", payload: { id: "n1" } } }));
    await settle();
    expect(b.frames).toContainEqual(expect.objectContaining({ t: "event", event: expect.objectContaining({ kind: "node.updated" }) }));
    expect(a.frames.some((f) => f.t === "event")).toBe(false);

    a.close(); b.close(); await settle();
    expect(realtime.hub.stats().workspaces).toBe(0);
  });

  it("drops presence frames above the rate limit instead of dropping the connection", async () => {
    auth.authenticate.mockResolvedValue({ kind: "user", userId: "u1" });
    auth.authoriseWorkspace.mockResolvedValue(GRANT);
    const a = await open("/realtime/ws/w2?token=t");
    await frame(a, 1);
    for (let i = 0; i < 20; i++) {
      a.send(JSON.stringify({ t: "presence", state: { key: "ka", userId: "u1", name: "Ana", color: "#f00", pageId: `p${i}` } }));
    }
    await settle();
    // The roster on join, then five presence fan-outs (one second's budget);
    // fifteen were dropped, and the socket is still open.
    expect(a.frames.length).toBe(1 + 5);
    expect(a.readyState).toBe(WebSocket.OPEN);
    a.close(); await settle();
  });
});

describe("realtime server — collab room", () => {
  it("relays a writer's updates and drops a viewer's", async () => {
    auth.authenticate.mockResolvedValue({ kind: "user", userId: "u1" });
    auth.authoriseNode
      .mockResolvedValueOnce({ grant: GRANT, workspaceId: "w1", canWrite: true })
      .mockResolvedValueOnce({ grant: GRANT, workspaceId: "w1", canWrite: false });
    const writer = await open("/realtime/collab/n1?token=t");
    const viewer = await open("/realtime/collab/n1?token=t");

    writer.send(JSON.stringify({ type: "update", clientId: 1, update: "AQ==" }));
    viewer.send(JSON.stringify({ type: "update", clientId: 2, update: "Ag==" }));   // dropped: cannot write
    viewer.send(JSON.stringify({ type: "awareness", clientId: 2, awareness: "Aw==" })); // relayed: cursors are fine
    viewer.send(JSON.stringify({ type: "sync-1", clientId: 2, sv: "AA==" }));       // relayed: asking is fine
    await settle();

    expect(viewer.frames).toEqual([{ type: "update", clientId: 1, update: "AQ==" }]);
    expect(writer.frames.map((f) => f.type).sort()).toEqual(["awareness", "sync-1"]);
    writer.close(); viewer.close(); await settle();
    expect(realtime.hub.stats().nodeRooms).toBe(0);
  });
});
