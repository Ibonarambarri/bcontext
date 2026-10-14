/**
 * Outlook — `outlook` → Nango `outlook` (alias of the `microsoft` OAuth2
 * provider; proxy base https://graph.microsoft.com).
 *
 * Messages received since the cursor in the mail folders you choose
 * (default: Inbox). Graph is asked for text bodies with
 * `Prefer: outlook.body-content-type="text"`; if a body still comes back as
 * HTML it is flattened. Drafts are skipped.
 *
 * Install config: `folders` (allow-list of well-known names such as
 * `inbox`, `archive`, or folder ids). Scope: Mail.Read.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { graphWalk, odataSince } from "./graph";
import { allowList, clip, htmlToText, type NangoAdapter } from "./shared";

interface Recipient { emailAddress?: { name?: string; address?: string } }
interface OutlookMessage {
  id: string;
  conversationId?: string;
  subject?: string | null;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  from?: Recipient;
  toRecipients?: Recipient[];
  receivedDateTime?: string;
  webLink?: string;
  isDraft?: boolean;
  hasAttachments?: boolean;
}

const KEY = "outlook";
const SELECT = "id,conversationId,subject,bodyPreview,body,from,toRecipients,receivedDateTime,webLink,isDraft,hasAttachments";

export function recipient(r: Recipient | undefined): string {
  const name = r?.emailAddress?.name;
  const address = r?.emailAddress?.address;
  if (name && address) return `${name} <${address}>`;
  return name ?? address ?? "";
}

export function outlookBodyText(m: OutlookMessage): string {
  const raw = m.body?.content ?? "";
  const text = m.body?.contentType?.toLowerCase() === "html" ? htmlToText(raw) : raw.trim();
  return text || m.bodyPreview?.trim() || "";
}

export const outlookAdapter: NangoAdapter = {
  id: KEY,
  provider: "outlook",
  sourceHint: "outlook:messages",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const folders = allowList(config, "folders") ?? ["inbox"];
    const signals: IngestSignal[] = [];
    const stats = { folders: 0, pages: 0, skipped: 0 };
    for (const folder of folders.slice(0, 10)) {
      stats.folders += 1;
      const { pages } = await graphWalk<OutlookMessage>(
        client,
        KEY,
        connectionId,
        `/v1.0/me/mailFolders/${encodeURIComponent(folder)}/messages`,
        {
          $filter: `receivedDateTime ge ${odataSince(since)}`,
          $orderby: "receivedDateTime desc",
          $select: SELECT,
          $top: Math.min(50, limit),
        },
        (m) => {
          if (m.isDraft) { stats.skipped += 1; return true; }
          const from = recipient(m.from);
          const to = (m.toRecipients ?? []).map(recipient).filter(Boolean).slice(0, 8).join(", ");
          signals.push({
            external_id: `message:${m.id}`,
            title: m.subject?.trim() || "(no subject)",
            text: [
              `${from ? `From: ${from}` : ""}${to ? `\nTo: ${to}` : ""}${m.hasAttachments ? "\nHas attachments" : ""}`.trim(),
              "",
              clip(outlookBodyText(m)),
            ].join("\n"),
            url: m.webLink,
            author: from || undefined,
            at: m.receivedDateTime,
            kind_hint: "email",
          });
          return signals.length < limit;
        },
        { maxPages: 5, headers: { Prefer: 'outlook.body-content-type="text"' } },
      );
      stats.pages += pages;
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats };
  },
};
