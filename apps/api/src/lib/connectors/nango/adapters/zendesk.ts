/**
 * Zendesk — `zendesk` → Nango `zendesk-api-key` (BASIC: email + API token;
 * connection_config.subdomain). Incremental ticket export (cursor-based)
 * since the cursor; solved/closed tickets also pull their public comments,
 * which is where the answer that resolved the problem lives.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { clip, epochSeconds, subdomain, type NangoAdapter } from "./shared";

interface ZendeskTicket {
  id: number;
  subject?: string;
  description?: string;
  status?: string;
  priority?: string | null;
  type?: string | null;
  tags?: string[];
  updated_at?: string;
  requester_id?: number;
}
interface ZendeskComment {
  id: number;
  author_id?: number;
  plain_body?: string;
  body?: string;
  public?: boolean;
  created_at?: string;
}

/** Solved tickets whose comments are fetched per run (one call each). */
export const ZENDESK_COMMENT_FETCH_MAX = 20;

export const zendeskAdapter: NangoAdapter = {
  id: "zendesk",
  provider: "zendesk-api-key",
  sourceHint: "zendesk:tickets",
  async fetchChanges({ client, connectionId, connectionConfig, since, limit }) {
    const base = subdomain(connectionConfig) ? `https://${subdomain(connectionConfig)}.zendesk.com` : "";
    const signals: IngestSignal[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let withComments = 0;
    do {
      const res = await client.proxy<{ tickets?: ZendeskTicket[]; after_cursor?: string | null; end_of_stream?: boolean }>({
        method: "GET",
        providerConfigKey: "zendesk",
        connectionId,
        path: "/api/v2/incremental/tickets/cursor.json",
        query: cursor ? { cursor } : { start_time: epochSeconds(since), per_page: Math.min(100, limit) },
      });
      if (!res.ok) throw new Error(`zendesk incremental tickets failed (${res.status})`);
      for (const t of res.data?.tickets ?? []) {
        let comments = "";
        if ((t.status === "solved" || t.status === "closed") && withComments < ZENDESK_COMMENT_FETCH_MAX) {
          withComments += 1;
          const c = await client.proxy<{ comments?: ZendeskComment[] }>({
            method: "GET",
            providerConfigKey: "zendesk",
            connectionId,
            path: `/api/v2/tickets/${t.id}/comments.json`,
          });
          if (c.ok) {
            comments = (c.data?.comments ?? [])
              .filter((x) => x.public !== false)
              .slice(-6)
              .map((x) => `- (${x.created_at ?? ""}) ${(x.plain_body ?? x.body ?? "").trim()}`)
              .join("\n");
          }
        }
        signals.push({
          external_id: `ticket:${t.id}`,
          title: `#${t.id} · ${t.subject ?? ""}`.trim(),
          text: [
            `Status: ${t.status ?? "?"}${t.priority ? ` · Priority: ${t.priority}` : ""}${t.type ? ` · Type: ${t.type}` : ""}`,
            t.tags?.length ? `Tags: ${t.tags.join(", ")}` : null,
            "",
            clip(t.description ?? ""),
            comments ? `\nConversation:\n${comments}` : null,
          ]
            .filter((x) => x !== null)
            .join("\n"),
          url: base ? `${base}/agent/tickets/${t.id}` : undefined,
          at: t.updated_at,
          kind_hint: "ticket",
        });
        if (signals.length >= limit) break;
      }
      cursor = res.data?.end_of_stream ? undefined : (res.data?.after_cursor ?? undefined);
      pages += 1;
    } while (cursor && signals.length < limit && pages < 5);
    return { signals: signals.slice(0, limit), stats: { pages, with_comments: withComments } };
  },
};
