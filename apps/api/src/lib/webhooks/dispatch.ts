/**
 * Outbound webhook fan-out.
 *
 * `emitEvent(workspaceId, type, data)` resolves all active endpoints that
 * subscribe to `type` and records one `webhook_deliveries` row per endpoint.
 * From there two delivery paths exist, chosen by `DATABASE_URL`:
 *
 *   - Direct connection configured (production): the rows and a
 *     `webhook.drain` job are written in one transaction and the pg-boss
 *     worker (`worker.ts` → `processDeliveries`) does the POSTing.
 *   - No direct connection (local/demo): the row is inserted via PostgREST
 *     and the signed CloudEvents body is POSTed best-effort, fire-and-forget,
 *     from this process. On failure it gets one immediate retry, then stays
 *     'pending' with `next_retry_at` set for the scheduled drain to pick up.
 *
 * Either way the caller's request never waits on an HTTP POST: node
 * create/update latency is unaffected by slow receivers.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildCloudEvent,
  matchesEvent,
  serializeEvent,
  sign,
  type WebhookEventType,
} from "@bcontext-dev/contract/webhooks/events";
import { log } from "@bcontext-dev/contract/log";
import { hasDatabaseUrl, withTransaction } from "@/lib/queue/db";
import { enqueue } from "@/lib/queue/producers";
import { QUEUE_WEBHOOK_DRAIN } from "@/lib/queue/queues";

export const MAX_ATTEMPTS = 3;
/** Backoff in seconds for retry #N (1-indexed). */
const BACKOFF_SECONDS = [30, 300, 1800];

interface EndpointRow {
  id: string;
  url: string;
  event_types: string[];
  secret_hash: string;
  paused: boolean;
}

export interface EmitEventInput<T = unknown> {
  workspaceId: string;
  workspaceSlug: string;
  type: WebhookEventType;
  data: T;
}

export interface EmitEventResult {
  enqueued: number;
  matched: number;
}

/**
 * Fan an event out to every subscribed endpoint in the workspace. Inserts
 * one `webhook_deliveries` row per match and best-effort dispatches now.
 *
 * Failures are swallowed — webhooks are observability, not consistency:
 * a Supabase outage during emit must not break the user write that
 * triggered the event. We log instead.
 */
export async function emitEvent<T>(
  admin: SupabaseClient,
  input: EmitEventInput<T>,
): Promise<EmitEventResult> {
  try {
    const { data, error } = await admin
      .from("webhook_endpoints")
      .select("id, url, event_types, secret_hash, paused")
      .eq("workspace_id", input.workspaceId)
      .eq("paused", false);
    if (error) {
      log.warn("webhook.emit.fetch_failed", {
        workspace_id: input.workspaceId,
        event_type: input.type,
        error: { message: error.message },
      });
      return { enqueued: 0, matched: 0 };
    }
    const endpoints = (data ?? []) as EndpointRow[];
    const matched = endpoints.filter((e) =>
      matchesEvent(e.event_types ?? [], input.type),
    );
    if (matched.length === 0) {
      return { enqueued: 0, matched: 0 };
    }

    const event = buildCloudEvent({
      type: input.type,
      workspaceSlug: input.workspaceSlug,
      data: input.data,
    });
    const body = serializeEvent(event);

    // When a direct connection is configured the delivery rows and the
    // worker job are written in ONE transaction, so a crash between the two
    // is not expressible. Delivery then happens in the worker instead of
    // in-request. Without DATABASE_URL we keep the in-request behaviour.
    if (hasDatabaseUrl()) {
      return await enqueueTransactionally(input, matched, event);
    }

    let enqueued = 0;
    for (const ep of matched) {
      const inserted = await insertPending(admin, {
        endpointId: ep.id,
        workspaceId: input.workspaceId,
        eventId: event.id,
        eventType: event.type,
        payload: event,
      });
      if (inserted) {
        enqueued++;
        // Fire-and-forget: do not block the caller on the upstream POST.
        void dispatchDelivery(admin, inserted, ep, body);
      }
    }

    return { enqueued, matched: matched.length };
  } catch (err) {
    log.warn("webhook.emit.failed", {
      workspace_id: input.workspaceId,
      event_type: input.type,
      error: { message: err instanceof Error ? err.message : String(err) },
    });
    return { enqueued: 0, matched: 0 };
  }
}

/**
 * Atomic path: insert one `webhook_deliveries` row per endpoint and queue the
 * drain job through the same transaction.
 *
 * `next_retry_at` is set to `now()` (rather than left NULL as the in-request
 * path does) so the drain can see the row: `processDeliveries` selects on
 * `next_retry_at <= now()` and then takes a CAS lock on `status`, so a
 * second worker replica racing for the same row is harmless.
 *
 * The retry ladder, signing and dead-lettering are unchanged — they live in
 * `processDeliveries` and are simply reached one hop later.
 */
async function enqueueTransactionally(
  input: { workspaceId: string },
  matched: readonly EndpointRow[],
  event: { id: string; type: string },
): Promise<EmitEventResult> {
  return withTransaction(async (tx) => {
    let enqueued = 0;
    for (const ep of matched) {
      const res = await tx.executeSql(
        `insert into webhook_deliveries
           (endpoint_id, workspace_id, event_id, event_type, payload,
            attempts, status, next_retry_at)
         values ($1, $2, $3, $4, $5::jsonb, 0, 'pending', now())
         returning id`,
        [
          ep.id,
          input.workspaceId,
          event.id,
          event.type,
          JSON.stringify(event),
        ],
      );
      if (res.rows.length > 0) enqueued++;
    }
    if (enqueued > 0) {
      // Same `tx` — the job row is part of this transaction. A rollback
      // takes the deliveries AND the job with it; a commit publishes both.
      await enqueue(
        QUEUE_WEBHOOK_DRAIN,
        { reason: "webhook.emit", workspace_id: input.workspaceId },
        { tx, singletonKey: "emit" },
      );
    }
    return { enqueued, matched: matched.length };
  });
}

interface InsertPendingInput {
  endpointId: string;
  workspaceId: string;
  eventId: string;
  eventType: string;
  payload: unknown;
}

async function insertPending(
  admin: SupabaseClient,
  input: InsertPendingInput,
): Promise<string | null> {
  const { data, error } = await admin
    .from("webhook_deliveries")
    .insert({
      endpoint_id: input.endpointId,
      workspace_id: input.workspaceId,
      event_id: input.eventId,
      event_type: input.eventType,
      payload: input.payload,
      attempts: 0,
      status: "pending",
    })
    .select("id")
    .single();
  if (error || !data) {
    log.warn("webhook.delivery.insert_failed", {
      endpoint_id: input.endpointId,
      event_type: input.eventType,
      error: { message: error?.message ?? "no row" },
    });
    return null;
  }
  return data.id as string;
}

/**
 * Attempt to POST the delivery to the endpoint. On 2xx → mark sent. On
 * anything else → bump attempts; if we still have budget, retry once
 * immediately. After that the row stays 'pending' with `next_retry_at`
 * set, awaiting the scheduled drain.
 *
 * The secret used for HMAC is the stored sha256 hash — receivers verify
 * against the same hash, since the plaintext is shown once at creation
 * and the receiver keeps it. (Symmetric MAC: any shared string works.)
 */
async function dispatchDelivery(
  admin: SupabaseClient,
  deliveryId: string,
  endpoint: EndpointRow,
  body: string,
): Promise<void> {
  // Sign once, reuse across retries (timestamp is fixed in the header
  // so the signature stays valid; the receiver's replay window decides
  // whether to accept a delayed delivery).
  const signed = sign(body, endpoint.secret_hash);

  let attempt = 0;
  let lastError: string | null = null;
  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    const outcome = await postOnce(endpoint.url, body, signed.header);
    if (outcome.ok) {
      await markSent(admin, deliveryId, attempt);
      await touchEndpoint(admin, endpoint.id);
      return;
    }
    lastError = outcome.error;
    // The first failure gets one immediate retry; later ones are
    // scheduled for the worker's drain.
    if (attempt >= 2) break;
  }

  // Out of in-request retries — schedule the next attempt.
  const backoff = BACKOFF_SECONDS[Math.min(attempt - 1, BACKOFF_SECONDS.length - 1)]!;
  const nextRetry = new Date(Date.now() + backoff * 1000).toISOString();
  const status = attempt >= MAX_ATTEMPTS ? "dead" : "retrying";
  await admin
    .from("webhook_deliveries")
    .update({
      attempts: attempt,
      status,
      last_error: lastError,
      next_retry_at: status === "retrying" ? nextRetry : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", deliveryId);
  log.warn("webhook.delivery.retry_scheduled", {
    delivery_id: deliveryId,
    endpoint_id: endpoint.id,
    status,
    attempts: attempt,
    next_retry_at: status === "retrying" ? nextRetry : null,
  });
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

async function markSent(
  admin: SupabaseClient,
  deliveryId: string,
  attempts: number,
): Promise<void> {
  await admin
    .from("webhook_deliveries")
    .update({
      status: "sent",
      attempts,
      last_error: null,
      next_retry_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", deliveryId);
}

async function touchEndpoint(
  admin: SupabaseClient,
  endpointId: string,
): Promise<void> {
  await admin
    .from("webhook_endpoints")
    .update({ last_delivery_at: new Date().toISOString() })
    .eq("id", endpointId);
}

/**
 * Pure helper exposed for tests: given a list of endpoint records and an
 * event type, return only those that should receive the event (active +
 * subscribed). Dedupes by id in case the same row appears twice.
 */
export function selectEndpointsForEvent(
  endpoints: readonly EndpointRow[],
  type: WebhookEventType,
): EndpointRow[] {
  const seen = new Set<string>();
  const out: EndpointRow[] = [];
  for (const ep of endpoints) {
    if (seen.has(ep.id)) continue;
    if (ep.paused) continue;
    if (!matchesEvent(ep.event_types ?? [], type)) continue;
    seen.add(ep.id);
    out.push(ep);
  }
  return out;
}
