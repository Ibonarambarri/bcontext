/**
 * Webhook delivery worker.
 *
 * Drains `webhook_deliveries` rows that are due for retry: status
 * IN ('pending', 'retrying') AND next_retry_at <= now(). For each, builds
 * the signed body from the original event payload and POSTs again with
 * the backoff ladder. After `MAX_ATTEMPTS` (3) the row flips to status='dead'
 * and shows up in the DLQ UI.
 *
 * Invoked by the pg-boss job `webhook.drain` (`src/lib/queue/handlers.ts`)
 * on a 60-second cadence, and on demand from `emitEvent`. Each invocation
 * processes up to `batchSize` rows (default 25) so a batch stays short. The
 * request path is a hot-path producer; this is the cold-path retry consumer
 * — they never compete.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { sign } from "@bcontext-dev/contract/webhooks/events";
import { log } from "@bcontext-dev/contract/log";

export const MAX_ATTEMPTS = 3;
const BACKOFF_SECONDS = [30, 300, 1800];

interface DeliveryRow {
  id: string;
  workspace_id: string;
  endpoint_id: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
}

interface EndpointRow {
  id: string;
  url: string;
  secret_hash: string;
  paused: boolean;
}

export interface WorkerResult {
  picked: number;
  sent: number;
  retried: number;
  dead: number;
}

export async function processDeliveries(
  admin: SupabaseClient,
  opts: { batchSize?: number; now?: Date } = {},
): Promise<WorkerResult> {
  const batchSize = opts.batchSize ?? 25;
  const now = (opts.now ?? new Date()).toISOString();

  const { data, error } = await admin
    .from("webhook_deliveries")
    .select("id, workspace_id, endpoint_id, payload, status, attempts")
    .in("status", ["pending", "retrying"])
    .lte("next_retry_at", now)
    .order("next_retry_at", { ascending: true })
    .limit(batchSize);
  if (error) {
    log.warn("webhook.worker.pickup_failed", { error: error.message });
    return { picked: 0, sent: 0, retried: 0, dead: 0 };
  }
  const rows = (data ?? []) as DeliveryRow[];
  if (rows.length === 0) return { picked: 0, sent: 0, retried: 0, dead: 0 };

  let sent = 0;
  let retried = 0;
  let dead = 0;

  for (const row of rows) {
    // Hot-lock: mark running so a parallel worker doesn't double-fire.
    const locked = await admin
      .from("webhook_deliveries")
      .update({
        status: "running",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("status", row.status) // CAS — only the original status wins
      .select("id")
      .maybeSingle();
    if (!locked.data) continue; // lost the race; skip

    const endpoint = await loadEndpoint(admin, row.endpoint_id);
    if (!endpoint || endpoint.paused) {
      // Endpoint deleted or paused — park the row.
      await admin
        .from("webhook_deliveries")
        .update({
          status: "dead",
          last_error: "endpoint_unavailable",
          next_retry_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      dead++;
      continue;
    }

    const body = JSON.stringify(row.payload);
    const signed = sign(body, endpoint.secret_hash);
    const attempt = row.attempts + 1;
    const outcome = await postOnce(endpoint.url, body, signed.header);

    if (outcome.ok) {
      await admin
        .from("webhook_deliveries")
        .update({
          status: "sent",
          attempts: attempt,
          last_error: null,
          next_retry_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      sent++;
      continue;
    }

    if (attempt >= MAX_ATTEMPTS) {
      await admin
        .from("webhook_deliveries")
        .update({
          status: "dead",
          attempts: attempt,
          last_error: outcome.error,
          next_retry_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      dead++;
      log.warn("webhook.worker.dead", {
        delivery_id: row.id,
        endpoint_id: endpoint.id,
        attempts: attempt,
        error: outcome.error,
      });
      continue;
    }

    const backoff =
      BACKOFF_SECONDS[Math.min(attempt - 1, BACKOFF_SECONDS.length - 1)] ?? 60;
    const next = new Date(Date.now() + backoff * 1000).toISOString();
    await admin
      .from("webhook_deliveries")
      .update({
        status: "retrying",
        attempts: attempt,
        last_error: outcome.error,
        next_retry_at: next,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    retried++;
  }

  log.info("webhook.worker.drained", {
    picked: rows.length,
    sent,
    retried,
    dead,
  });

  return { picked: rows.length, sent, retried, dead };
}

async function loadEndpoint(
  admin: SupabaseClient,
  id: string,
): Promise<EndpointRow | null> {
  const { data } = await admin
    .from("webhook_endpoints")
    .select("id, url, secret_hash, paused")
    .eq("id", id)
    .maybeSingle();
  return (data as EndpointRow | null) ?? null;
}

interface PostOutcome {
  ok: boolean;
  status?: number;
  error: string | null;
}

async function postOnce(
  url: string,
  body: string,
  signature: string,
): Promise<PostOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/cloudevents+json",
        "X-Signature": signature,
        "User-Agent": "bcontext-webhooks/1.0",
      },
      body,
      signal: controller.signal,
    });
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status, error: null };
    }
    return { ok: false, status: res.status, error: `http ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
