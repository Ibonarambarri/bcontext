/**
 * WebSockets on the API process. Two paths:
 *
 *   /realtime/ws/:workspaceId      presence + invalidation events
 *   /realtime/collab/:nodeId       Yjs relay for one document
 *
 * Both authenticate on the upgrade — `?token=` — and are refused with an HTTP
 * status before any socket exists, so an unauthorised client never gets a
 * connection to probe with. Authorisation is the grant (see auth.ts).
 *
 * `ws` is attached to the `http.Server` that `@hono/node-server` returns rather
 * than going through a Hono adapter: @hono/node-ws wants node-server 1.x, and
 * an upgrade is an HTTP event this server already emits. Less between the wire
 * and the hub is the point.
 *
 * Frames are JSON, the same shapes the clients spoke to Supabase Realtime:
 *
 *   workspace, client → server:  { t: "presence", state }   { t: "event", event }
 *   workspace, server → client:  { t: "presence", peers }   { t: "event", event }
 *   collab, both ways:           the provider's Message, relayed verbatim
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { log } from "@bcontext-dev/contract/log";
import { authenticate, authoriseNode, authoriseWorkspace } from "./auth";
import { RealtimeHub, installHub, type Peer, type PresenceState } from "@/lib/realtime/hub";
import { publishWorkspaceEvent } from "@/lib/realtime/publish";

const WS_PATH = /^\/realtime\/ws\/([^/?]+)/;
const COLLAB_PATH = /^\/realtime\/collab\/([^/?]+)/;

/** Presence frames per peer per second; above it they are dropped, not queued. */
const PRESENCE_RATE = 5;
/** Largest frame accepted. A Yjs update for a large document fits comfortably. */
const MAX_FRAME_BYTES = 512 * 1024;

export interface RealtimeServer {
  hub: RealtimeHub;
  close(): Promise<void>;
}

export function attachRealtime(server: Server): RealtimeServer {
  const hub = new RealtimeHub();
  installHub(hub);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void handleUpgrade(req, socket, head).catch((err) => {
      log.error("realtime.upgrade.failed", { error: err instanceof Error ? err.message : String(err) });
      refuse(socket, 500);
    });
  };
  server.on("upgrade", onUpgrade);

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? "/", "http://realtime");
    const ws = WS_PATH.exec(url.pathname);
    const collab = COLLAB_PATH.exec(url.pathname);
    if (!ws && !collab) return refuse(socket, 404);

    const actor = await authenticate(url.searchParams.get("token"));
    if (!actor) return refuse(socket, 401);

    if (ws) {
      const workspaceId = decodeURIComponent(ws[1]!);
      const grant = await authoriseWorkspace(actor, workspaceId);
      if (!grant) return refuse(socket, 404); // not 403: an unreachable workspace does not exist
      wss.handleUpgrade(req, socket, head, (client) => workspaceConnection(client, workspaceId));
      return;
    }

    const nodeId = decodeURIComponent(collab![1]!);
    const access = await authoriseNode(actor, nodeId);
    if (!access) return refuse(socket, 404);
    wss.handleUpgrade(req, socket, head, (client) => collabConnection(client, nodeId, access.canWrite));
  }

  function workspaceConnection(client: WebSocket, workspaceId: string): void {
    const peer = asPeer(client);
    hub.joinWorkspace(workspaceId, peer);
    let presenceBudget = PRESENCE_RATE;
    const refill = setInterval(() => { presenceBudget = PRESENCE_RATE; }, 1000);

    client.on("message", (raw) => {
      const frame = parse(raw);
      if (!frame) return;
      if (frame.t === "presence" && isPresence(frame.state)) {
        // The rate limit that made Supabase drop the channel lives here now,
        // where it costs a dropped frame instead of a dropped connection.
        if (presenceBudget-- <= 0) return;
        hub.setPresence(workspaceId, peer.key, { ...frame.state, ts: Date.now() });
      } else if (frame.t === "event" && isEvent(frame.event)) {
        // Local sockets synchronously, then the channel for the other
        // instances — a tab's edit has to reach a colleague on the other one.
        void publishWorkspaceEvent(
          workspaceId,
          { ...frame.event, from: frame.event.from ?? peer.key, ts: Date.now() },
          { exceptKey: peer.key },
        );
      }
    });
    client.on("close", () => { clearInterval(refill); hub.leaveWorkspace(workspaceId, peer.key); });
    client.on("error", () => client.close());
  }

  function collabConnection(client: WebSocket, nodeId: string, canWrite: boolean): void {
    const peer = asPeer(client);
    hub.joinNode(nodeId, peer);
    client.on("message", (raw) => {
      const text = raw.toString();
      const frame = parse(raw) as { type?: string } | null;
      if (!frame?.type) return;
      // A viewer may follow cursors and ask for state; only a writer changes
      // the document. sync-2 carries state too, so it is a write as well.
      if (!canWrite && (frame.type === "update" || frame.type === "sync-2")) return;
      hub.relayNode(nodeId, text, peer.key);
    });
    client.on("close", () => hub.leaveNode(nodeId, peer.key));
    client.on("error", () => client.close());
  }

  return {
    hub,
    close: () =>
      new Promise((resolve) => {
        // Detach first: a closed WebSocketServer must not be handed any more
        // upgrades, and nothing else in the process should find this hub.
        server.off("upgrade", onUpgrade);
        installHub(null);
        for (const c of wss.clients) c.close(1001, "server shutting down");
        wss.close(() => resolve());
      }),
  };
}

function asPeer(client: WebSocket): Peer {
  const key = randomUUID();
  return {
    key,
    send: (text) => {
      if (client.readyState === client.OPEN) client.send(text);
    },
  };
}

function refuse(socket: Duplex, status: 401 | 404 | 500): void {
  const reason = status === 401 ? "Unauthorized" : status === 404 ? "Not Found" : "Internal Server Error";
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function parse(raw: unknown): Record<string, unknown> | null {
  try {
    const v = JSON.parse(String(raw));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isPresence(v: unknown): v is Omit<PresenceState, "ts"> {
  const s = v as Record<string, unknown> | null;
  return Boolean(s && typeof s.key === "string" && s.key.length <= 80 && typeof s.userId === "string" && typeof s.name === "string" && typeof s.color === "string" && (s.pageId === null || typeof s.pageId === "string"));
}

function isEvent(v: unknown): v is { kind: string; payload: unknown; from?: string | number | null } {
  const e = v as Record<string, unknown> | null;
  return Boolean(e && typeof e.kind === "string" && "payload" in e);
}
