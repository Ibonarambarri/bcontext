/**
 * One way out for a workspace event, whatever process is sending it.
 *
 *  1. If this process holds the hub (the API), its sockets get the event
 *     right now — synchronously, before any I/O, so a route's "tell
 *     everyone" is still a method call.
 *  2. If `DATABASE_URL` is set, the event is `pg_notify`'d on the shared
 *     channel so every *other* API instance fans it out too, and so the
 *     worker reaches the sockets without an HTTP hop. This replaced
 *     `POST /realtime/broadcast` with a shared secret as the worker → API
 *     path; the POST stays as the fallback below.
 *  3. If there is no hub and no channel — or the channel refused the event —
 *     the event goes over HTTP to the API process, as it did before. Also
 *     the only path for an event too large for NOTIFY (8000 bytes) from a
 *     process without sockets; an API instance keeps such an event local
 *     and says so in the log, which is the documented limit of the channel.
 *
 * Failures never propagate. A realtime hiccup must not break a user's edit.
 */
import { randomUUID } from "node:crypto";
import { log } from "@bcontext-dev/contract/log";
import { getPool, hasDatabaseUrl } from "@/lib/queue/db";
import { getHub, type WorkspaceEvent } from "./hub";
import { CHANNEL, INSTANCE_ID, deliveredIds, encodeNotification, fitsNotify } from "./notify";

export interface PublishOptions {
  /**
   * Reuse an id the event already carries (an HTTP fallback re-entering the
   * API) so the dedupe holds across paths. Fresh events get a new one.
   */
  id?: string;
  /** Local fan-out skips this peer — the socket the event came in on. */
  exceptKey?: string;
}

export interface PublishOutcome {
  id: string;
  /** Sockets on this instance that received the event. */
  local: number;
  /** How the event left this process, if it did. */
  relay: "notify" | "http" | "oversize" | "none";
}

export async function publishWorkspaceEvent(
  workspaceId: string,
  event: WorkspaceEvent,
  opts: PublishOptions = {},
): Promise<PublishOutcome> {
  const id = opts.id ?? randomUUID();
  const hub = getHub();
  let local = 0;
  if (hub) {
    // Already fanned out here — the channel and the HTTP path overlapped.
    if (deliveredIds.seen(id)) return { id, local: 0, relay: "none" };
    local = hub.broadcastEvent(workspaceId, event, opts.exceptKey);
  }

  if (hasDatabaseUrl()) {
    const payload = encodeNotification({ id, origin: INSTANCE_ID, workspaceId, event });
    if (fitsNotify(payload)) {
      try {
        await getPool().query("select pg_notify($1, $2)", [CHANNEL, payload]);
        return { id, local, relay: "notify" };
      } catch (err) {
        log.warn("realtime.notify.failed", {
          workspace_id: workspaceId,
          kind: event.kind,
          error: err instanceof Error ? err.message : String(err),
        });
        // Fall through: a process without sockets still has the HTTP path.
      }
    } else if (hub) {
      log.warn("realtime.notify.oversize", { workspace_id: workspaceId, kind: event.kind, bytes: Buffer.byteLength(payload) });
      return { id, local, relay: "oversize" };
    }
  }

  if (hub) return { id, local, relay: "none" };
  return (await postToApi(id, workspaceId, event)) ? { id, local, relay: "http" } : { id, local, relay: "none" };
}

/** The pre-channel path: hand the event to the process that holds the sockets. */
async function postToApi(id: string, workspaceId: string, event: WorkspaceEvent): Promise<boolean> {
  const origin = process.env.API_ORIGIN?.replace(/\/$/, "");
  const secret = process.env.REALTIME_SECRET;
  if (!origin || !secret) {
    // No API process to hand it to: demo mode, tests, or a deployment that
    // has not started the api resource yet. The UI still works — mutations
    // and reads go through the store — it just does not hear about others'
    // edits.
    return false;
  }
  try {
    const res = await fetch(`${origin}/realtime/broadcast`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ id, workspaceId, event }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      log.warn("realtime.broadcast.rejected", { workspace_id: workspaceId, kind: event.kind, status: res.status });
      return false;
    }
    return true;
  } catch (err) {
    log.warn("realtime.broadcast.failed", {
      workspace_id: workspaceId,
      kind: event.kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
