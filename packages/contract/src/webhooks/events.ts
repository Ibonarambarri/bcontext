/**
 * Outbound webhook event utilities.
 *
 * Pure helpers: no I/O, no Supabase. Everything here is deterministic and
 * easy to unit-test. Two concerns:
 *
 *   1. Building a CloudEvents v1.0 envelope around the workspace-internal
 *      event payload. We emit application/cloudevents+json bodies — this
 *      matches AWS EventBridge / GitHub / the modern webhook ecosystem.
 *   2. Signing the body with HMAC-SHA256, in the Stripe / Standard
 *      Webhooks shape: `X-Signature: t=<unix>,v1=<base64-hmac>`. Receivers
 *      verify by recomputing `HMAC(secret, `${t}.${body}`)` and comparing
 *      against `v1` with a timing-safe compare.
 *
 * The event-type catalog is intentionally tiny: we only emit a handful of
 * lifecycle types today. Adding more later is a one-line change here +
 * any call sites that want to fire them.
 */
import { createHmac, randomUUID } from "node:crypto";

export const WEBHOOK_EVENT_TYPES = [
  "node.created",
  "node.updated",
  "node.deleted",
  "node.linked",
  "chat.thread.completed",
  "job.completed",
  "skill.invoked",
  /** NEXO published a weekly digest doc (src/lib/skills/digest.ts). */
  "digest.published",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

const EVENT_TYPE_SET = new Set<string>(WEBHOOK_EVENT_TYPES);

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return typeof value === "string" && EVENT_TYPE_SET.has(value);
}

export function parseEventTypes(input: unknown): WebhookEventType[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<WebhookEventType>();
  for (const v of input) if (isWebhookEventType(v)) seen.add(v);
  return Array.from(seen);
}

/** CloudEvents v1.0 envelope shape — JSON Object Format. */
export interface CloudEvent<T = unknown> {
  specversion: "1.0";
  id: string;
  source: string;
  type: WebhookEventType;
  time: string;
  datacontenttype: "application/json";
  data: T;
}

export interface BuildEventInput<T = unknown> {
  type: WebhookEventType;
  workspaceSlug: string;
  data: T;
  /** Override the id (otherwise a random uuid). Useful for tests. */
  id?: string;
  /** Override the timestamp (otherwise `new Date()`). Useful for tests. */
  time?: Date;
}

/**
 * Build a CloudEvents v1.0 envelope. Always uses `application/json` for
 * the `data` payload — receivers don't need to inspect content-type.
 *
 * `source` follows the `bcontext/<slug>` pattern from the spec; receivers
 * use it to attribute the event to a specific workspace.
 */
export function buildCloudEvent<T>(
  input: BuildEventInput<T>,
): CloudEvent<T> {
  return {
    specversion: "1.0",
    id: input.id ?? randomUUID(),
    source: `bcontext/${input.workspaceSlug}`,
    type: input.type,
    time: (input.time ?? new Date()).toISOString(),
    datacontenttype: "application/json",
    data: input.data,
  };
}

/**
 * Serialize a CloudEvent to its canonical JSON body. This is the exact
 * string passed to HMAC + sent on the wire — callers must NOT re-stringify
 * the parsed event before signing or signatures won't match.
 */
export function serializeEvent(event: CloudEvent<unknown>): string {
  return JSON.stringify(event);
}

/**
 * Compute the HMAC-SHA256 signature line for an outbound delivery. The
 * format is compatible with Stripe / Standard Webhooks:
 *
 *   X-Signature: t=<unix>,v1=<base64-hmac>
 *
 * The signing input is `${t}.${body}` — including the timestamp lets the
 * receiver reject replays older than its tolerance window.
 *
 * `tsSeconds` is exposed so callers can pin time (and tests can assert
 * determinism). Defaults to `Math.floor(Date.now() / 1000)`.
 */
export function sign(
  body: string,
  secret: string,
  tsSeconds?: number,
): { ts: number; v1: string; header: string } {
  const ts = tsSeconds ?? Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", secret)
    .update(`${ts}.${body}`)
    .digest("base64");
  return { ts, v1: mac, header: `t=${ts},v1=${mac}` };
}

/**
 * Generate a fresh secret for a new endpoint. Format `whsec_<base64url>`,
 * 32 bytes of entropy. Caller stores the sha256 of the suffix; the
 * plaintext is shown once.
 */
export function generateSecret(): { secret: string; prefix: string } {
  // 32 random bytes → 43-char base64url. We pull this through Node's crypto
  // so it works in the API-route runtime without the Web Crypto random pool.
  const bytes = new Uint8Array(32);
  // randomUUID gives us 122 bits; we need 256. Use crypto.getRandomValues
  // which is available in the Node runtime we target.
  globalThis.crypto.getRandomValues(bytes);
  const b64 = Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const secret = `whsec_${b64}`;
  return { secret, prefix: secret.slice(0, 12) };
}

/**
 * sha256 of the secret suffix (the part after the prefix). Stored in the
 * DB; never the plaintext.
 */
export async function hashSecret(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Decide whether a given endpoint should receive a given event type.
 *
 * Rules:
 *   - empty `subscribed` ⇒ match nothing (caller chose to subscribe to
 *     zero events; treat as paused).
 *   - the literal `"*"` is a wildcard.
 *   - exact match otherwise.
 */
export function matchesEvent(
  subscribed: readonly string[],
  type: WebhookEventType,
): boolean {
  if (subscribed.length === 0) return false;
  if (subscribed.includes("*")) return true;
  return subscribed.includes(type);
}
