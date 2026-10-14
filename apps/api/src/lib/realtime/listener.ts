/**
 * `LISTEN` on the realtime channel and feed the hub of this process.
 *
 * One connection, checked out of the shared pool for the life of the process
 * and never handed back — LISTEN is per session, and a pooled client that
 * went back to the pool would be listening for whoever borrowed it next.
 * When the session dies (pooler restart, network blip, Postgres restart) the
 * client is destroyed, not returned, and a fresh one is checked out after a
 * backoff that starts at a second and caps at thirty. Events published while
 * disconnected are lost, which is what a realtime channel promises anyway:
 * the client's next fetch is the source of truth, the event only says
 * "fetch now".
 *
 * Started by the API entrypoint when `DATABASE_URL` is set. Without it there
 * is nothing to listen on and the HTTP fallback in `publish.ts` carries the
 * worker's events, as before.
 */
import type { PoolClient } from "pg";
import { log } from "@bcontext-dev/contract/log";
import { getPool } from "@/lib/queue/db";
import type { RealtimeHub } from "./hub";
import { CHANNEL, INSTANCE_ID, decodeNotification, deliveredIds } from "./notify";

export interface RealtimeListener {
  /** UNLISTEN, hand the client back, stop reconnecting. */
  stop(): Promise<void>;
  /** For tests and `/realtime/stats`: is a session currently listening? */
  readonly connected: boolean;
}

export interface ListenerOptions {
  /** First reconnect delay; doubles per failure up to `maxReconnectDelayMs`. */
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

export function startRealtimeListener(hub: RealtimeHub, opts: ListenerOptions = {}): RealtimeListener {
  const base = opts.reconnectDelayMs ?? 1000;
  const max = opts.maxReconnectDelayMs ?? 30_000;
  let delay = base;
  let stopped = false;
  let client: PoolClient | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const handle = (payload: string | undefined) => {
    const n = decodeNotification(payload);
    if (!n) {
      log.warn("realtime.listen.bad_payload", { bytes: payload ? Buffer.byteLength(payload) : 0 });
      return;
    }
    // Our own echo: the publisher already fanned it out before notifying.
    if (n.origin === INSTANCE_ID) return;
    if (deliveredIds.seen(n.id)) return;
    hub.broadcastEvent(n.workspaceId, n.event);
  };

  const schedule = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void connect();
    }, delay);
    delay = Math.min(delay * 2, max);
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    let c: PoolClient;
    try {
      c = await getPool().connect();
    } catch (err) {
      log.warn("realtime.listen.connect_failed", { error: err instanceof Error ? err.message : String(err), retry_ms: delay });
      schedule();
      return;
    }
    client = c;
    const lost = (err?: Error) => {
      if (client !== c) return; // already replaced or stopped
      client = null;
      c.removeAllListeners("notification");
      try {
        c.release(true); // destroy: the session is gone or unknowable
      } catch {
        // already destroyed
      }
      if (stopped) return;
      log.warn("realtime.listen.lost", { error: err?.message ?? "connection ended", retry_ms: delay });
      schedule();
    };
    c.on("notification", (msg) => {
      if (msg.channel === CHANNEL) handle(msg.payload);
    });
    c.once("error", lost);
    c.once("end", () => lost());
    try {
      await c.query(`LISTEN ${CHANNEL}`);
    } catch (err) {
      lost(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    delay = base;
    log.info("realtime.listen.ready", { channel: CHANNEL, instance: INSTANCE_ID });
  };

  void connect();

  return {
    get connected() {
      return client !== null;
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const c = client;
      client = null;
      if (!c) return;
      c.removeAllListeners("notification");
      try {
        await c.query(`UNLISTEN ${CHANNEL}`);
        c.release();
      } catch {
        try {
          c.release(true);
        } catch {
          // gone already
        }
      }
    },
  };
}
