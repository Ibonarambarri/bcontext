"use client";

import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import { openSocket, realtimeUrl, type Socket } from "@/lib/realtime/client";

/**
 * Live-collab provider for a single Yjs document keyed by `nodeId`.
 *
 * Transport priority:
 *  1. The realtime server on the API process (`/realtime/collab/<id>`) when
 *     `NEXT_PUBLIC_REALTIME_URL` is set. A pure relay: the server authorises
 *     the room against the person's grant on the node and forwards frames
 *     verbatim, so every editor of the document converges across machines.
 *  2. `BroadcastChannel` (`collab:node:<id>`) — same-browser-only fallback.
 *     Lets the developer demo collab against two tabs without a server.
 *
 * Wire protocol (all messages are JSON with base64 payloads — one shape for
 * both transports, and the server never has to decode a Yjs update):
 *
 *   { type: "sync-1", clientId, sv }                  // I just connected — here's my state vector
 *   { type: "sync-2", clientId, update, target }      // Here's what you're missing (or full state)
 *   { type: "update", clientId, update }              // Live doc update
 *   { type: "awareness", clientId, awareness }        // Live cursor/selection broadcast
 *   { type: "leave", clientId }                       // Clean disconnect — drop awareness state
 */

type Message =
  | { type: "sync-1"; clientId: number; sv: string }
  | { type: "sync-2"; clientId: number; update: string; target?: number }
  | { type: "update"; clientId: number; update: string }
  | { type: "awareness"; clientId: number; awareness: string }
  | { type: "leave"; clientId: number };

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  if (typeof btoa === "function") return btoa(bin);
  // node fallback (shouldn't run client-side, but keeps the bundler happy)
  return Buffer.from(bytes).toString("base64");
}

function b64decode(s: string): Uint8Array {
  const bin = typeof atob === "function" ? atob(s) : Buffer.from(s, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type Transport = {
  send: (msg: Message) => void;
  close: () => void;
};

export interface ProviderOpts {
  doc: Y.Doc;
  awareness: Awareness;
  nodeId: string;
  /** Force the BroadcastChannel transport even if a realtime server is configured. */
  forceLocal?: boolean;
}

/**
 * Owns one transport for one document: wires Yjs/awareness updates out, applies
 * incoming frames with `this` as origin so they are not echoed back. `destroy()`
 * announces the leave so peers drop the cursor immediately.
 */
export class CollabProvider {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly nodeId: string;
  readonly clientId: number;
  private transport: Transport | null = null;
  private destroyed = false;
  private connectedListeners = new Set<(c: boolean) => void>();
  private connected = false;

  constructor(opts: ProviderOpts) {
    this.doc = opts.doc;
    this.awareness = opts.awareness;
    this.nodeId = opts.nodeId;
    this.clientId = opts.doc.clientID;

    this.doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);

    if (!opts.forceLocal && realtimeUrl()) {
      this.transport = this.openSocketTransport();
    } else {
      this.transport = this.openBroadcastTransport();
    }

    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", this.onBeforeUnload);
    }
  }

  /** Subscribe to transport state; fires once with the current value, returns the unsubscribe. */
  onConnectionChange(fn: (connected: boolean) => void): () => void {
    this.connectedListeners.add(fn);
    fn(this.connected);
    return () => this.connectedListeners.delete(fn);
  }

  private setConnected(c: boolean) {
    if (this.connected === c) return;
    this.connected = c;
    for (const fn of this.connectedListeners) fn(c);
  }

  /* ────── Transports ─────────────────────────────────────────────────── */

  private openSocketTransport(): Transport {
    const sock: Socket = openSocket(`/realtime/collab/${encodeURIComponent(this.nodeId)}`, {
      onOpen: () => {
        this.setConnected(true);
        // Ask the room what it knows so we can catch up — on every (re)connect,
        // because whatever happened while we were away is exactly the gap.
        this.broadcast({
          type: "sync-1",
          clientId: this.clientId,
          sv: b64encode(Y.encodeStateVector(this.doc)),
        });
      },
      onMessage: (text) => {
        try {
          this.handleMessage(JSON.parse(text) as Message);
        } catch {
          /* not ours */
        }
      },
      onClose: () => this.setConnected(false),
    });
    return {
      send: (msg) => sock.send(JSON.stringify(msg)),
      close: () => sock.close(),
    };
  }

  private openBroadcastTransport(): Transport {
    if (typeof BroadcastChannel === "undefined") {
      // No BroadcastChannel and no realtime server — single-tab mode. Provider is
      // a no-op but the editor still works locally.
      this.setConnected(false);
      return { send: () => {}, close: () => {} };
    }
    const bc = new BroadcastChannel(`collab:node:${this.nodeId}`);
    bc.onmessage = (e: MessageEvent<Message>) => this.handleMessage(e.data);
    this.setConnected(true);
    // Same sync handshake.
    queueMicrotask(() => {
      this.broadcast({
        type: "sync-1",
        clientId: this.clientId,
        sv: b64encode(Y.encodeStateVector(this.doc)),
      });
    });
    return {
      send: (msg) => {
        try {
          bc.postMessage(msg);
        } catch {
          /* channel closed */
        }
      },
      close: () => bc.close(),
    };
  }

  /* ────── Outgoing ────────────────────────────────────────────────────── */

  private broadcast(msg: Message) {
    this.transport?.send(msg);
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return; // Came from a remote peer; don't echo.
    this.broadcast({
      type: "update",
      clientId: this.clientId,
      update: b64encode(update),
    });
  };

  private onAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === this) return;
    const ids = [...changes.added, ...changes.updated, ...changes.removed];
    if (ids.length === 0) return;
    const update = encodeAwarenessUpdate(this.awareness, ids);
    this.broadcast({
      type: "awareness",
      clientId: this.clientId,
      awareness: b64encode(update),
    });
  };

  private onBeforeUnload = () => {
    // Tell peers to drop our cursor.
    this.broadcast({ type: "leave", clientId: this.clientId });
    removeAwarenessStates(this.awareness, [this.clientId], "local");
  };

  /* ────── Incoming ────────────────────────────────────────────────────── */

  private handleMessage(msg: Message) {
    if (msg.clientId === this.clientId) return; // own echo
    switch (msg.type) {
      case "sync-1": {
        // Peer just connected. Reply with what they're missing.
        const sv = b64decode(msg.sv);
        const update = Y.encodeStateAsUpdate(this.doc, sv);
        this.broadcast({
          type: "sync-2",
          clientId: this.clientId,
          target: msg.clientId,
          update: b64encode(update),
        });
        // Also send our awareness so the peer paints our cursor right away.
        const a = encodeAwarenessUpdate(this.awareness, [this.clientId]);
        this.broadcast({
          type: "awareness",
          clientId: this.clientId,
          awareness: b64encode(a),
        });
        return;
      }
      case "sync-2": {
        if (msg.target !== undefined && msg.target !== this.clientId) return;
        Y.applyUpdate(this.doc, b64decode(msg.update), this);
        return;
      }
      case "update": {
        Y.applyUpdate(this.doc, b64decode(msg.update), this);
        return;
      }
      case "awareness": {
        applyAwarenessUpdate(this.awareness, b64decode(msg.awareness), this);
        return;
      }
      case "leave": {
        removeAwarenessStates(this.awareness, [msg.clientId], this);
        return;
      }
    }
  }

  /* ────── Teardown ────────────────────────────────────────────────────── */

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.onBeforeUnload();
    if (typeof window !== "undefined") {
      window.removeEventListener("beforeunload", this.onBeforeUnload);
    }
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    this.transport?.close();
    this.transport = null;
    this.connectedListeners.clear();
  }
}
