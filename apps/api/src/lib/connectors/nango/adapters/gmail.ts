/**
 * Gmail — `gmail` → Nango `google-mail` (OAuth2 via `google`; proxy base
 * https://gmail.googleapis.com). Messages received since the cursor, by
 * default INBOX minus the Promotions/Social categories, or only the labels
 * the workspace lists in `config.labels` (label names, e.g. "NEXO"). The
 * top messages are fetched in full and their text/plain part decoded.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, base64UrlToText, clip, epochSeconds, htmlToText, type NangoAdapter } from "./shared";

interface GmailPart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailPart & { headers?: Array<{ name?: string; value?: string }> };
}

/** How many messages are fetched in full per run (one call each). */
export const GMAIL_FULL_FETCH_MAX = 40;

export function gmailQuery(since: Date, labels: string[] | null): string {
  const base = `after:${epochSeconds(since)}`;
  if (labels) return `${base} (${labels.map((l) => `label:${l.replace(/\s+/g, "-")}`).join(" OR ")})`;
  return `${base} in:inbox -category:promotions -category:social`;
}

function header(msg: GmailMessage, name: string): string {
  return msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Prefer text/plain; fall back to text/html flattened; else the snippet. */
export function gmailBodyText(msg: GmailMessage): string {
  let plain = "";
  let html = "";
  const walk = (part?: GmailPart) => {
    if (!part) return;
    const data = part.body?.data;
    if (data && part.mimeType === "text/plain" && !plain) plain = base64UrlToText(data);
    else if (data && part.mimeType === "text/html" && !html) html = base64UrlToText(data);
    for (const p of part.parts ?? []) walk(p);
  };
  walk(msg.payload);
  return (plain || (html ? htmlToText(html) : "") || msg.snippet || "").trim();
}

export const gmailAdapter: NangoAdapter = {
  id: "gmail",
  provider: "google-mail",
  sourceHint: "gmail:messages",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const labels = allowList(config, "labels");
    const list = await client.proxy<{ messages?: Array<{ id: string; threadId?: string }>; nextPageToken?: string }>({
      method: "GET",
      providerConfigKey: "gmail",
      connectionId,
      path: "/gmail/v1/users/me/messages",
      query: { q: gmailQuery(since, labels), maxResults: Math.min(limit, GMAIL_FULL_FETCH_MAX) },
    });
    if (!list.ok) throw new Error(`gmail messages.list failed (${list.status})`);
    const ids = (list.data?.messages ?? []).slice(0, Math.min(limit, GMAIL_FULL_FETCH_MAX));
    const signals: IngestSignal[] = [];
    let fetched = 0;
    for (const { id } of ids) {
      const res = await client.proxy<GmailMessage>({
        method: "GET",
        providerConfigKey: "gmail",
        connectionId,
        path: `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`,
        query: { format: "full" },
      });
      fetched += 1;
      if (!res.ok || !res.data) continue;
      const msg = res.data;
      const subject = header(msg, "Subject");
      const from = header(msg, "From");
      const to = header(msg, "To");
      const at = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : undefined;
      signals.push({
        external_id: `message:${msg.id}`,
        title: subject || "(no subject)",
        text: [
          `From: ${from}${to ? ` · To: ${to}` : ""}`,
          msg.labelIds?.length ? `Labels: ${msg.labelIds.join(", ")}` : null,
          "",
          clip(gmailBodyText(msg)),
        ]
          .filter((x) => x !== null)
          .join("\n"),
        url: msg.threadId ? `https://mail.google.com/mail/u/0/#all/${msg.threadId}` : undefined,
        author: from || undefined,
        at,
        kind_hint: "email",
      });
    }
    return { signals, stats: { listed: ids.length, fetched } };
  },
};
