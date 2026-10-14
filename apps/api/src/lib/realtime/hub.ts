/**
 * Rooms, presence and fan-out for the realtime server — no sockets in here.
 *
 * Everything the server does that is worth testing lives in this file, against
 * a `Peer` interface a test can satisfy with a function. The WebSocket layer
 * (`src/api/realtime/server.ts`) only translates frames into these calls.
 *
 * Two kinds of room, because the two things the UI does live are different:
 *
 *  - `ws:<workspaceId>` carries presence (who is here, on which page) and
 *    invalidation events (a node changed, refetch). One per workspace.
 *  - `node:<nodeId>` relays Yjs messages between the editors of one document.
 *    The server never decodes them; the markdown remains the source of truth
 *    and the first client in loads from the API, as before.
 *
 * Why a Map and not Redis: the sockets of one instance live in this process,
 * and fan-out between instances is Postgres LISTEN/NOTIFY (`publish.ts`
 * sends, `listener.ts` receives and calls `broadcastEvent` here). The hub
 * itself never knows there is another instance.
 */

export interface Peer {
  /** Stable per connection; presence is keyed by it. */
  readonly key: string;
  send(text: string): void;
}

export interface PresenceState {
  /**
   * The client's own key. The roster is keyed by it rather than by the
   * socket so a tab keeps its identity across a reconnect, and so the client
   * can recognise — and hide — itself in the list.
   */
  key: string;
  userId: string;
  name: string;
  color: string;
  pageId: string | null;
  ts: number;
}

export type PresencePeer = PresenceState & { presenceKey: string };

/** What a workspace room fans out. Mirrors the client's `WorkspaceRealtimeEvent`. */
export interface WorkspaceEvent {
  kind: string;
  payload: unknown;
  from: string | number | null;
  ts: number;
}

interface WorkspaceRoom {
  peers: Map<string, { peer: Peer; presence: PresenceState | null }>;
}

interface NodeRoom {
  peers: Map<string, Peer>;
}

export class RealtimeHub {
  private workspaces = new Map<string, WorkspaceRoom>();
  private nodes = new Map<string, NodeRoom>();

  /* ── workspace rooms ─────────────────────────────────────────────── */

  joinWorkspace(workspaceId: string, peer: Peer): void {
    const room = this.workspaces.get(workspaceId) ?? { peers: new Map() };
    room.peers.set(peer.key, { peer, presence: null });
    this.workspaces.set(workspaceId, room);
    // A newcomer needs the roster before anyone moves.
    peer.send(JSON.stringify({ t: "presence", peers: this.roster(workspaceId) }));
  }

  leaveWorkspace(workspaceId: string, peerKey: string): void {
    const room = this.workspaces.get(workspaceId);
    if (!room) return;
    const had = room.peers.get(peerKey)?.presence !== null;
    room.peers.delete(peerKey);
    if (room.peers.size === 0) {
      this.workspaces.delete(workspaceId);
      return;
    }
    if (had) this.fanoutPresence(workspaceId);
  }

  /** A peer's own presence. The roster is rebroadcast to the room. */
  setPresence(workspaceId: string, peerKey: string, state: PresenceState): void {
    const entry = this.workspaces.get(workspaceId)?.peers.get(peerKey);
    if (!entry) return;
    entry.presence = state;
    this.fanoutPresence(workspaceId);
  }

  /** Fan an event out to everyone in the workspace but its sender. */
  broadcastEvent(workspaceId: string, event: WorkspaceEvent, exceptKey?: string): number {
    const room = this.workspaces.get(workspaceId);
    if (!room) return 0;
    const frame = JSON.stringify({ t: "event", event });
    let delivered = 0;
    for (const [key, { peer }] of room.peers) {
      if (key === exceptKey) continue;
      peer.send(frame);
      delivered++;
    }
    return delivered;
  }

  roster(workspaceId: string): PresencePeer[] {
    const room = this.workspaces.get(workspaceId);
    if (!room) return [];
    const out: PresencePeer[] = [];
    for (const { presence } of room.peers.values()) {
      if (presence) out.push({ presenceKey: presence.key, ...presence });
    }
    return out;
  }

  private fanoutPresence(workspaceId: string): void {
    const room = this.workspaces.get(workspaceId);
    if (!room) return;
    const frame = JSON.stringify({ t: "presence", peers: this.roster(workspaceId) });
    for (const { peer } of room.peers.values()) peer.send(frame);
  }

  /* ── node (Yjs) rooms ────────────────────────────────────────────── */

  joinNode(nodeId: string, peer: Peer): void {
    const room = this.nodes.get(nodeId) ?? { peers: new Map() };
    room.peers.set(peer.key, peer);
    this.nodes.set(nodeId, room);
  }

  leaveNode(nodeId: string, peerKey: string): void {
    const room = this.nodes.get(nodeId);
    if (!room) return;
    room.peers.delete(peerKey);
    if (room.peers.size === 0) this.nodes.delete(nodeId);
  }

  /**
   * Relay a Yjs frame to the other editors of the document, verbatim. A
   * `target` (sync-2 replies) goes to one peer's socket set, but peers are
   * keyed by connection while Yjs identifies clients by `clientId`, so the
   * frame is relayed to everyone but the sender and the provider ignores
   * frames addressed elsewhere — exactly what it does on BroadcastChannel.
   */
  relayNode(nodeId: string, frame: string, exceptKey: string): number {
    const room = this.nodes.get(nodeId);
    if (!room) return 0;
    let delivered = 0;
    for (const [key, peer] of room.peers) {
      if (key === exceptKey) continue;
      peer.send(frame);
      delivered++;
    }
    return delivered;
  }

  /* ── observability ───────────────────────────────────────────────── */

  stats(): { workspaces: number; nodeRooms: number; connections: number } {
    let connections = 0;
    for (const r of this.workspaces.values()) connections += r.peers.size;
    for (const r of this.nodes.values()) connections += r.peers.size;
    return { workspaces: this.workspaces.size, nodeRooms: this.nodes.size, connections };
  }
}

/**
 * The one hub of this process. `publish.ts` reaches for it so an API route's
 * "tell everyone" is a method call, not a POST to another continent. Null in
 * every process that is not the API — there, the broadcast goes over the
 * NOTIFY channel (or HTTP, without a database) to the processes that hold
 * the sockets.
 */
let hub: RealtimeHub | null = null;

export function getHub(): RealtimeHub | null {
  return hub;
}

export function installHub(h: RealtimeHub | null): void {
  hub = h;
}
