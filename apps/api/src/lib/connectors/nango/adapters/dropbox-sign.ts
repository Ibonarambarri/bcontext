/**
 * Dropbox Sign — `dropbox-sign` → Nango `dropbox-sign` (OAuth2; proxy base
 * https://api.hellosign.com).
 *
 * The list endpoint has no "modified since" filter, so we page the account's
 * signature requests (newest created first) and keep the ones whose latest
 * event — creation or the last signer action — happened after the cursor.
 * The page loop stops as soon as a whole page is older than the cursor by
 * creation time (≤3 pages). One signal per request: title, overall status,
 * per-signer status (names only, never emails) and the details link.
 *
 * Assumptions (docs, not exercised live): `GET /v3/signature_request/list`
 * with `page`/`page_size`, envelope `{ signature_requests, list_info }`,
 * unix-second `created_at`, `signatures[].signed_at`/`status_code`.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { clip, str, type NangoAdapter } from "./shared";

interface DropboxSignSignature {
  signer_name?: string | null;
  signer_role?: string | null;
  status_code?: string;
  signed_at?: number | null;
  last_viewed_at?: number | null;
  decline_reason?: string | null;
}

interface DropboxSignRequest {
  signature_request_id: string;
  title?: string;
  subject?: string;
  message?: string | null;
  created_at?: number;
  expires_at?: number | null;
  is_complete?: boolean;
  is_declined?: boolean;
  has_error?: boolean;
  details_url?: string;
  requester_email_address?: string;
  signatures?: DropboxSignSignature[];
}

interface DropboxSignList {
  signature_requests?: DropboxSignRequest[];
  list_info?: { page?: number; num_pages?: number };
}

function iso(seconds: number | null | undefined): string | undefined {
  return seconds ? new Date(seconds * 1000).toISOString() : undefined;
}

/** The instant of the newest event on a request: creation or the last signer action. */
export function latestEventAt(r: DropboxSignRequest): number {
  let latest = r.created_at ?? 0;
  for (const s of r.signatures ?? []) {
    if (s.signed_at && s.signed_at > latest) latest = s.signed_at;
  }
  return latest;
}

export function requestStatus(r: DropboxSignRequest): string {
  if (r.is_declined) return "declined";
  if (r.has_error) return "error";
  if (r.is_complete) return "completed";
  return "pending";
}

export const dropboxSignAdapter: NangoAdapter = {
  id: "dropbox-sign",
  provider: "dropbox-sign",
  sourceHint: "dropbox-sign:signature_requests",
  async fetchChanges({ client, connectionId, since, limit }) {
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = { pages: 0, scanned: 0 };
    const sinceSec = Math.floor(since.getTime() / 1000);
    let page = 1;
    let numPages = 1;
    do {
      const res = await client.proxy<DropboxSignList>({
        method: "GET",
        providerConfigKey: "dropbox-sign",
        connectionId,
        path: "/v3/signature_request/list",
        query: { page, page_size: 100 },
      });
      if (!res.ok) throw new Error(`dropbox-sign list failed (${res.status})`);
      stats.pages = (stats.pages ?? 0) + 1;
      const rows = res.data?.signature_requests ?? [];
      numPages = res.data?.list_info?.num_pages ?? 1;
      stats.scanned = (stats.scanned ?? 0) + rows.length;
      let anyRecentByCreation = false;
      for (const r of rows) {
        if ((r.created_at ?? 0) > sinceSec) anyRecentByCreation = true;
        const latest = latestEventAt(r);
        if (latest <= sinceSec) continue;
        const status = requestStatus(r);
        const signers = (r.signatures ?? [])
          .map((s) => {
            const who = s.signer_name || s.signer_role || "signer";
            const state = s.status_code ?? (s.signed_at ? "signed" : "awaiting_signature");
            const reason = s.decline_reason ? ` — ${clip(s.decline_reason, 200)}` : "";
            return `- ${who}: ${state}${s.signed_at ? ` (${iso(s.signed_at)})` : ""}${reason}`;
          })
          .join("\n");
        signals.push({
          external_id: `signature_request:${r.signature_request_id}:${status}`,
          title: str(r.title) || str(r.subject) || `Signature request ${r.signature_request_id}`,
          text: [
            `Status: ${status}${r.expires_at ? ` · Expires: ${iso(r.expires_at)}` : ""}`,
            r.subject && r.subject !== r.title ? `Subject: ${r.subject}` : null,
            r.message ? `\n${clip(r.message, 1500)}` : null,
            signers ? `\nSigners:\n${signers}` : null,
          ]
            .filter((l) => l !== null)
            .join("\n"),
          url: r.details_url,
          at: iso(latest),
          kind_hint: "signature_request",
        });
        if (signals.length >= limit) break;
      }
      if (signals.length >= limit || !anyRecentByCreation || rows.length === 0) break;
      page += 1;
    } while (page <= numPages && page <= 3);
    return { signals: signals.slice(0, limit), stats };
  },
};
