"use client";

/**
 * The browser's side of a realtime socket.
 *
 * One place for the three things every realtime consumer needs and none
 * should implement twice: where the server is, how to prove who you are, and
 * what to do when the connection drops. Both the workspace presence provider
 * and the Yjs collab provider are built on `openSocket`.
 *
 * Token: the access JWT of the Supabase session. The API validates it with
 * Supabase Auth, the same way it validates the cookie — but a WebSocket
 * upgrade to the API's origin carries no cookie of the web's origin, so the
 * token travels in the query string instead. It is short-lived and the socket
 * outlives it by design: authorisation happens once, at the handshake.
 */
import { getSupabaseBrowserLazy } from "@/lib/supabase/browser-lazy";
import { publicEnv } from "@/lib/public-env";

/**
 * The API process's origin as a WebSocket URL: `wss://<your domain>` behind
 * the bundled Caddy, `ws://localhost:4000` in development. Paths
 * (`/realtime/ws/…`) are the callers'. Unset → no realtime server, and
 * callers fall back to BroadcastChannel. Read at runtime (@/lib/public-env).
 */
export function realtimeUrl(): string | null {
  const raw = publicEnv().realtimeUrl;
  return raw ? raw.replace(/\/$/, "") : null;
}

async function realtimeToken(): Promise<string | null> {
  try {
    const { data } = await (await getSupabaseBrowserLazy()).auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/** `onOpen` fires on every (re)connect, not just the first — re-announce there. */
export interface SocketHandlers {
  onOpen?: () => void;
  onMessage: (text: string) => void;
  onClose?: () => void;
}

export interface Socket {
  /** Queued until the socket is open; dropped once closed for good. */
  send(text: string): void;
  close(): void;
}

const BACKOFF_MS = [500, 1000, 2000, 5000, 10000] as const;

/**
 * Open `${realtimeUrl()}${path}` and keep it open.
 *
 * Reconnects with backoff after an unexpected close and calls `onOpen` again
 * each time, so a consumer re-announces itself (presence, Yjs sync-1) without
 * tracking connection state of its own. A 401/404 at the handshake shows up
 * here as an immediate close; those are not retried more than the backoff
 * allows, and a caller that keeps getting them has a permissions problem the
 * UI should already be showing.
 */
export function openSocket(path: string, handlers: SocketHandlers): Socket {
  const base = realtimeUrl();
  if (!base || typeof WebSocket === "undefined") {
    return { send: () => {}, close: () => {} };
  }

  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const queue: string[] = [];

  const connect = async () => {
    if (closed) return;
    const token = await realtimeToken();
    if (closed) return;
    if (!token) {
      // Not signed in (yet). Try again later rather than hammering with 401s.
      schedule();
      return;
    }
    const sock = new WebSocket(`${base}${path}?token=${encodeURIComponent(token)}`);
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
      while (queue.length) sock.send(queue.shift()!);
      handlers.onOpen?.();
    };
    sock.onmessage = (e) => handlers.onMessage(typeof e.data === "string" ? e.data : String(e.data));
    sock.onclose = () => {
      if (ws === sock) ws = null;
      handlers.onClose?.();
      schedule();
    };
    sock.onerror = () => sock.close();
  };

  const schedule = () => {
    if (closed || timer) return;
    const delay = BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)];
    timer = setTimeout(() => { timer = null; void connect(); }, delay);
  };

  void connect();

  return {
    send: (text) => {
      if (closed) return;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(text);
      else if (queue.length < 200) queue.push(text);
    },
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close(1000, "client closed");
      ws = null;
    },
  };
}
