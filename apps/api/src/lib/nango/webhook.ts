/**
 * Inbound webhooks from Nango (https://nango.dev/docs/guides/platform/webhooks-from-nango).
 *
 * We only care about `type: "auth"` / `operation: "creation"` — the moment a
 * workspace finishes the Connect UI. Verification, in order of strength:
 *
 *   1. `X-Nango-Hmac-Sha256` = HMAC-SHA256(body, NANGO_WEBHOOK_SECRET)
 *      when the signing key is configured — required to match.
 *   2. Otherwise the legacy `X-Nango-Signature` = SHA-256(secretKey + body)
 *      when present — required to match.
 *   3. Independently of headers, the connection named in the payload must
 *      exist in Nango under our integration (the connector's `complete`
 *      phase looks it up), so a forged body cannot activate an install with
 *      a connection Nango does not know.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface NangoAuthWebhook {
  type: "auth";
  operation: "creation" | "override" | "refresh" | string;
  connectionId: string;
  providerConfigKey: string;
  provider?: string;
  authMode?: string;
  environment?: string;
  success?: boolean;
  error?: unknown;
  tags?: { end_user_id?: string; end_user_email?: string; organization_id?: string };
  endUser?: { endUserId?: string; organizationId?: string };
}

export function parseNangoWebhook(raw: string): NangoAuthWebhook | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.type !== "auth") return null;
  if (typeof b.connectionId !== "string" || typeof b.providerConfigKey !== "string") return null;
  return b as unknown as NangoAuthWebhook;
}

export function workspaceIdFromWebhook(hook: NangoAuthWebhook): string | null {
  return hook.tags?.end_user_id ?? hook.endUser?.endUserId ?? hook.tags?.organization_id ?? null;
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export type SignatureCheck = "hmac_ok" | "legacy_ok" | "unsigned" | "invalid";

export function verifyNangoSignature(
  rawBody: string,
  headers: Record<string, string>,
  keys: { webhookSecret?: string | null; secretKey?: string | null },
): SignatureCheck {
  const hmacHeader = headers["x-nango-hmac-sha256"];
  if (keys.webhookSecret) {
    if (!hmacHeader) return "invalid";
    const expected = createHmac("sha256", keys.webhookSecret).update(rawBody).digest("hex");
    return safeEqualHex(expected, hmacHeader.toLowerCase()) ? "hmac_ok" : "invalid";
  }
  const legacyHeader = headers["x-nango-signature"];
  if (legacyHeader && keys.secretKey) {
    const expected = createHash("sha256").update(`${keys.secretKey}${rawBody}`).digest("hex");
    return safeEqualHex(expected, legacyHeader.toLowerCase()) ? "legacy_ok" : "invalid";
  }
  return "unsigned";
}
