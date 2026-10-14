/**
 * The wire between processes and instances: one Postgres NOTIFY channel.
 *
 * Every workspace event that leaves a process is `pg_notify`'d on
 * `CHANNEL` with the JSON below as payload; every API instance `LISTEN`s and
 * feeds what arrives into its own hub (`listener.ts`). That is how the worker
 * reaches the sockets without an HTTP hop and a shared secret, and how two
 * API instances fan the same edit out to both sets of sockets. The database
 * is already the one thing every process shares; the channel costs nothing
 * new to run and nothing new to secure.
 *
 * Two things this file owns because both ends need them identical:
 *
 *  - the codec — `encodeNotification` / `decodeNotification` — including the
 *    size rule. Postgres refuses a NOTIFY payload of 8000 bytes or more, so
 *    an event that does not fit falls back (`publish.ts`) instead of failing.
 *  - the dedupe — `SeenIds` — keyed by the event id every notification
 *    carries. An instance ignores what it originated (it delivered locally
 *    before notifying) and anything it has already delivered, so the HTTP
 *    fallback and the channel can overlap without a client seeing an event
 *    twice.
 *
 * Nothing here touches a socket or a connection; that is why it can be
 * tested with strings.
 */
import { randomUUID } from "node:crypto";
import type { WorkspaceEvent } from "./hub";

/** The NOTIFY channel. One for the whole deployment; the payload scopes. */
export const CHANNEL = "bcontext_realtime";

/**
 * Postgres' hard limit is 8000 bytes; stay under it with room for the
 * quoting `pg_notify` does not need but a future `NOTIFY` statement would.
 */
export const MAX_NOTIFY_BYTES = 7900;

/**
 * This process, for the lifetime of the process. It is the `origin` of every
 * notification it sends, so its own listener can drop the echo.
 */
export const INSTANCE_ID = randomUUID();

export interface RealtimeNotification {
  /** Unique per event; the dedupe key across channel and HTTP fallback. */
  id: string;
  /** `INSTANCE_ID` of the sender. */
  origin: string;
  workspaceId: string;
  event: WorkspaceEvent;
}

interface WireNotification extends RealtimeNotification {
  v: 1;
}

export function encodeNotification(n: RealtimeNotification): string {
  const wire: WireNotification = { v: 1, id: n.id, origin: n.origin, workspaceId: n.workspaceId, event: n.event };
  return JSON.stringify(wire);
}

/** True when the encoded payload is small enough for `pg_notify`. */
export function fitsNotify(payload: string): boolean {
  return Buffer.byteLength(payload, "utf8") <= MAX_NOTIFY_BYTES;
}

/**
 * Parse a payload from the channel. Anything that is not exactly what
 * `encodeNotification` writes comes back as `null` — a listener must never
 * fan out a frame it cannot vouch for, and the channel is reachable by
 * anything with a database connection.
 */
export function decodeNotification(raw: string | undefined | null): RealtimeNotification | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const w = v as Partial<WireNotification>;
  if (w.v !== 1) return null;
  if (typeof w.id !== "string" || !w.id) return null;
  if (typeof w.origin !== "string" || !w.origin) return null;
  if (typeof w.workspaceId !== "string" || !w.workspaceId) return null;
  const e = w.event as Partial<WorkspaceEvent> | null | undefined;
  if (!e || typeof e !== "object" || typeof e.kind !== "string" || !("payload" in e)) return null;
  const from = typeof e.from === "string" || typeof e.from === "number" ? e.from : null;
  const ts = typeof e.ts === "number" ? e.ts : Date.now();
  return {
    id: w.id,
    origin: w.origin,
    workspaceId: w.workspaceId,
    event: { kind: e.kind, payload: e.payload, from, ts },
  };
}

/**
 * A bounded set of event ids in insertion order. Old ids fall off the front
 * once `capacity` is reached; an id that comes back after that many events
 * is a replay nobody cares about any more.
 */
export class SeenIds {
  private readonly ids = new Set<string>();

  constructor(private readonly capacity = 4096) {}

  /** Records `id`. Returns true when it was already recorded. */
  seen(id: string): boolean {
    if (this.ids.has(id)) return true;
    this.ids.add(id);
    if (this.ids.size > this.capacity) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    return false;
  }

  get size(): number {
    return this.ids.size;
  }
}

/**
 * The ids this process has already fanned out to its sockets, shared by the
 * publisher (which marks what it delivered locally) and the listener (which
 * drops what it has seen).
 */
export const deliveredIds = new SeenIds();
