"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { openSocket, realtimeUrl, type Socket } from "@/lib/realtime/client";

/**
 * Workspace-wide realtime substrate.
 *
 * One transport per workspace, layered above the per-document Yjs channel
 * (`collab:node:<id>`) which keeps owning CRDT sync (text caret + selection).
 * This channel carries two streams:
 *
 *   • Presence — every connected tab tracks identity (user/name/color) plus
 *     the page (node id) it is currently viewing. Other tabs render those
 *     peers in the top-bar roster and as small avatar chips on the matching
 *     tree row.
 *
 *   • Broadcast — client-side fire-and-forget invalidation events
 *     (`node.created/renamed/deleted/moved`, `backlink.changed`). The tab
 *     that performs a mutation emits the event after the API write succeeds;
 *     other tabs run `router.refresh()` and the server-rendered tree picks
 *     up the change.
 *
 * Transport selection (mirrors CollabProvider):
 *   1. The realtime server on the API process (`/realtime/ws/<workspaceId>`)
 *      when `NEXT_PUBLIC_REALTIME_URL` is set — works across machines, and
 *      presence is on: the server keeps the roster, so you see colleagues, not
 *      just your own tabs.
 *   2. `BroadcastChannel` fallback so two tabs of the same browser still
 *      sync presence + invalidations in demo / unconfigured mode.
 *   3. No-op as last resort (single tab, no transport).
 */

/** One connected tab as the roster shows it; `presenceKey` is per tab, `userId` per person. */
export interface PresencePeer {
  presenceKey: string;
  userId: string;
  name: string;
  color: string;
  pageId: string | null;
  ts: number;
}

/** A fire-and-forget invalidation frame; `from` is the emitting tab's presence key. */
export interface WorkspaceRealtimeEvent<T = unknown> {
  kind: string;
  payload: T;
  from: string | number | null;
  ts: number;
}

interface RealtimeApi {
  enabled: boolean;
  selfKey: string;
  peers: PresencePeer[];
  setPageId: (pageId: string | null) => void;
  broadcast: (kind: string, payload: unknown) => void;
  on: (
    kind: string,
    handler: (event: WorkspaceRealtimeEvent) => void,
  ) => () => void;
}

const NOOP_API: RealtimeApi = {
  enabled: false,
  selfKey: "local",
  peers: [],
  setPageId: () => {},
  broadcast: () => {},
  on: () => () => {},
};

const Ctx = createContext<RealtimeApi>(NOOP_API);

/** The whole channel API; outside a provider it is the no-op (`enabled: false`). */
export function useWorkspaceRealtime(): RealtimeApi {
  return useContext(Ctx);
}

export function useWorkspacePresence(): PresencePeer[] {
  return useContext(Ctx).peers;
}

/**
 * Subscribe to one event kind for the component's lifetime. The handler is
 * kept in a ref so callers may pass an inline closure without resubscribing
 * on every render.
 */
export function useWorkspaceBroadcast(
  kind: string,
  handler: (event: WorkspaceRealtimeEvent) => void,
): void {
  const { on } = useContext(Ctx);
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  useEffect(() => {
    return on(kind, (event) => handlerRef.current(event));
  }, [kind, on]);
}

function genKey(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `c-${crypto.randomUUID()}`;
  }
  return `c-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/* ─── BroadcastChannel fallback wire format ─────────────────────────────── */

type BcEnvelope =
  | { t: "presence-update"; key: string; state: PresencePayload }
  | { t: "presence-leave"; key: string }
  | { t: "presence-request" }
  | { t: "event"; event: WorkspaceRealtimeEvent };

interface PresencePayload {
  userId: string;
  name: string;
  color: string;
  pageId: string | null;
  ts: number;
}

interface ProviderProps {
  workspaceId: string | null;
  userId: string;
  name: string;
  color: string;
  initialPageId: string | null;
  children: React.ReactNode;
}

/**
 * Mounted once by the workspace layout with the signed-in person's identity.
 * Picks the transport at mount (`realtimeUrl()` decides) and keeps the local
 * presence payload in a ref so page changes and identity changes are sent
 * without re-rendering the tree.
 */
export function WorkspaceRealtimeProvider({
  workspaceId,
  userId,
  name,
  color,
  initialPageId,
  children,
}: ProviderProps) {
  const serverMode = Boolean(realtimeUrl());
  const enabled = Boolean(workspaceId);
  const selfKey = useMemo(() => genKey(), []);

  const [peers, setPeers] = useState<PresencePeer[]>([]);
  const sockRef = useRef<Socket | null>(null);
  const bcRef = useRef<BroadcastChannel | null>(null);
  const handlersRef = useRef<Map<string, Set<(e: WorkspaceRealtimeEvent) => void>>>(
    new Map(),
  );

  const localStateRef = useRef<PresencePayload>({
    userId,
    name,
    color,
    pageId: initialPageId,
    ts: Date.now(),
  });

  const bcPeersRef = useRef<Map<string, PresencePayload>>(new Map());

  const flushPresence = useCallback(() => {
    localStateRef.current.ts = Date.now();
    if (sockRef.current) {
      sockRef.current.send(
        JSON.stringify({ t: "presence", state: { key: selfKey, ...localStateRef.current } }),
      );
      return;
    }
    if (bcRef.current) {
      try {
        bcRef.current.postMessage({
          t: "presence-update",
          key: selfKey,
          state: { ...localStateRef.current },
        } satisfies BcEnvelope);
      } catch {
        // channel closed
      }
    }
  }, [selfKey]);

  const setPageId = useCallback(
    (pageId: string | null) => {
      if (localStateRef.current.pageId === pageId) return;
      localStateRef.current.pageId = pageId;
      flushPresence();
    },
    [flushPresence],
  );

  const dispatchEvent = useCallback((event: WorkspaceRealtimeEvent) => {
    const handlers = handlersRef.current.get(event.kind);
    if (!handlers) return;
    for (const h of handlers) {
      try {
        h(event);
      } catch {
        // never let a single handler kill the channel
      }
    }
  }, []);

  const broadcast = useCallback(
    (kind: string, payload: unknown) => {
      const event: WorkspaceRealtimeEvent = {
        kind,
        payload,
        from: selfKey,
        ts: Date.now(),
      };
      if (sockRef.current) {
        sockRef.current.send(JSON.stringify({ t: "event", event }));
        return;
      }
      if (bcRef.current) {
        try {
          bcRef.current.postMessage({
            t: "event",
            event,
          } satisfies BcEnvelope);
        } catch {
          /* closed */
        }
      }
    },
    [selfKey],
  );

  const on = useCallback(
    (kind: string, handler: (event: WorkspaceRealtimeEvent) => void) => {
      let set = handlersRef.current.get(kind);
      if (!set) {
        set = new Set();
        handlersRef.current.set(kind, set);
      }
      set.add(handler);
      return () => {
        const cur = handlersRef.current.get(kind);
        if (!cur) return;
        cur.delete(handler);
        if (cur.size === 0) handlersRef.current.delete(kind);
      };
    },
    [],
  );

  /* ─── Realtime server transport ────────────────────────────────────── */
  useEffect(() => {
    if (!enabled || !workspaceId || !serverMode) return;

    const sock = openSocket(`/realtime/ws/${encodeURIComponent(workspaceId)}`, {
      // On every (re)connect: the server only knows what we tell it.
      onOpen: () => flushPresence(),
      onMessage: (text) => {
        let frame: { t?: string; peers?: PresencePeer[]; event?: WorkspaceRealtimeEvent };
        try {
          frame = JSON.parse(text);
        } catch {
          return;
        }
        if (frame.t === "presence" && Array.isArray(frame.peers)) {
          // The roster includes this tab; the UI wants everyone else.
          setPeers(frame.peers.filter((p) => p.presenceKey !== selfKey));
        } else if (frame.t === "event" && frame.event && typeof frame.event.kind === "string") {
          dispatchEvent(frame.event);
        }
      },
      onClose: () => setPeers([]),
    });
    sockRef.current = sock;

    return () => {
      sockRef.current = null;
      sock.close();
      setPeers([]);
    };
  }, [enabled, workspaceId, serverMode, selfKey, dispatchEvent, flushPresence]);

  /* ─── BroadcastChannel fallback (same-browser only) ───────────────────── */
  useEffect(() => {
    if (!enabled || !workspaceId || serverMode) return;
    if (typeof BroadcastChannel === "undefined") return;

    const bc = new BroadcastChannel(`ws:${workspaceId}:realtime`);
    bcRef.current = bc;

    const rebuildPeerList = () => {
      const next: PresencePeer[] = [];
      for (const [key, payload] of bcPeersRef.current) {
        next.push({
          presenceKey: key,
          userId: payload.userId,
          name: payload.name,
          color: payload.color,
          pageId: payload.pageId,
          ts: payload.ts,
        });
      }
      setPeers(next);
    };

    bc.onmessage = (e: MessageEvent<BcEnvelope>) => {
      const msg = e.data;
      if (!msg) return;
      switch (msg.t) {
        case "presence-update":
          if (msg.key === selfKey) return;
          bcPeersRef.current.set(msg.key, msg.state);
          rebuildPeerList();
          return;
        case "presence-leave":
          if (msg.key === selfKey) return;
          bcPeersRef.current.delete(msg.key);
          rebuildPeerList();
          return;
        case "presence-request":
          try {
            bc.postMessage({
              t: "presence-update",
              key: selfKey,
              state: { ...localStateRef.current },
            } satisfies BcEnvelope);
          } catch {
            /* closed */
          }
          return;
        case "event":
          if (msg.event.from === selfKey) return;
          dispatchEvent(msg.event);
          return;
      }
    };

    try {
      bc.postMessage({
        t: "presence-update",
        key: selfKey,
        state: { ...localStateRef.current },
      } satisfies BcEnvelope);
      bc.postMessage({ t: "presence-request" } satisfies BcEnvelope);
    } catch {
      /* closed */
    }

    // Sweep BroadcastChannel peers that haven't heartbeat'd in 5 s.
    const STALE_MS = 5000;
    const sweep = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [key, payload] of bcPeersRef.current) {
        if (now - payload.ts > STALE_MS) {
          bcPeersRef.current.delete(key);
          changed = true;
        }
      }
      if (changed) rebuildPeerList();
    }, 1000);

    const onBeforeUnload = () => {
      try {
        bc.postMessage({
          t: "presence-leave",
          key: selfKey,
        } satisfies BcEnvelope);
      } catch {
        /* closed */
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      clearInterval(sweep);
      try {
        bc.postMessage({
          t: "presence-leave",
          key: selfKey,
        } satisfies BcEnvelope);
      } catch {
        /* closed */
      }
      bcRef.current = null;
      bc.close();
      bcPeersRef.current.clear();
      setPeers([]);
    };
  }, [enabled, workspaceId, serverMode, selfKey, dispatchEvent]);

  // Identity change propagation.
  useEffect(() => {
    localStateRef.current.userId = userId;
    localStateRef.current.name = name;
    localStateRef.current.color = color;
    flushPresence();
  }, [userId, name, color, flushPresence]);

  // 2 s heartbeat so idle peers don't fall out of the BroadcastChannel
  // staleness sweep. The server needs none: a socket that closes leaves.
  useEffect(() => {
    if (!enabled || serverMode) return;
    const id = setInterval(() => flushPresence(), 2000);
    return () => clearInterval(id);
  }, [enabled, serverMode, flushPresence]);

  const api: RealtimeApi = useMemo(
    () => ({
      enabled,
      selfKey,
      peers,
      setPageId,
      broadcast,
      on,
    }),
    [enabled, selfKey, peers, setPageId, broadcast, on],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
