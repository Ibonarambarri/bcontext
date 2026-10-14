/**
 * Front — `front` → Nango `front-api-key` (API_KEY: API token). Conversations
 * updated since the cursor through the search endpoint
 * (`GET /conversations/search/<query>`, query `updated_after:<epoch>` plus an
 * optional `inbox:` clause per `config.inbox_ids`), then the last messages and
 * comments of each so the signal carries the exchange, not just the subject.
 *
 * Assumptions (docs, not exercised live): search results come back as
 * `{ _results, _pagination: { next } }`, messages/comments the same way;
 * `updated_after:` is accepted in the search grammar with unix seconds.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, epochSeconds, htmlToText, type NangoAdapter } from "./shared";

interface FrontPerson {
  first_name?: string;
  last_name?: string;
  email?: string;
  name?: string;
}

interface FrontConversation {
  id: string;
  subject?: string;
  status?: string;
  status_category?: string;
  assignee?: FrontPerson | null;
  tags?: Array<{ name?: string }>;
  created_at?: number;
  last_message?: { created_at?: number };
  _links?: { self?: string };
}

interface FrontMessage {
  id: string;
  type?: string;
  is_inbound?: boolean;
  created_at?: number;
  author?: FrontPerson | null;
  recipients?: Array<{ handle?: string; role?: string }>;
  body?: string;
  text?: string;
}

interface FrontComment {
  id: string;
  author?: FrontPerson | null;
  body?: string;
  posted_at?: number;
}

interface FrontPage<T> {
  _results?: T[];
  _pagination?: { next?: string | null };
}

const MAX_PAGES = 4;
const DETAIL_LIMIT = 20;

function personName(p?: FrontPerson | null): string {
  if (!p) return "";
  const full = [p.first_name, p.last_name].filter(Boolean).join(" ").trim();
  return full || p.name || p.email || "";
}

function isoFromSeconds(s?: number): string | undefined {
  return typeof s === "number" && Number.isFinite(s) ? new Date(s * 1000).toISOString() : undefined;
}

/** Front search query for "updated after the cursor", optionally scoped to inboxes. */
export function frontSearchQuery(since: Date, inboxIds: string[] | null): string {
  const parts = [`updated_after:${epochSeconds(since)}`];
  if (inboxIds?.length) parts.push(...inboxIds.map((id) => `inbox:${id}`));
  return parts.join(" ");
}

export const frontAdapter: NangoAdapter = {
  id: "front",
  provider: "front-api-key",
  sourceHint: "front:conversations",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const inboxIds = allowList(config, "inbox_ids");
    const query = frontSearchQuery(since, inboxIds);
    const conversations: FrontConversation[] = [];
    let path = `/conversations/search/${encodeURIComponent(query)}`;
    let pages = 0;
    while (path && pages < MAX_PAGES && conversations.length < limit) {
      const res = await client.proxy<FrontPage<FrontConversation>>({
        method: "GET",
        providerConfigKey: "front",
        connectionId,
        path,
        query: pages === 0 ? { limit: Math.min(100, limit) } : undefined,
      });
      if (!res.ok) throw new Error(`front search failed (${res.status})`);
      conversations.push(...(res.data?._results ?? []));
      pages += 1;
      const next = res.data?._pagination?.next;
      path = next ? next.replace(/^https?:\/\/[^/]+/, "") : "";
    }

    const signals: IngestSignal[] = [];
    let detailed = 0;
    for (const c of conversations.slice(0, limit)) {
      const lines: string[] = [
        `Status: ${c.status ?? "?"}${c.status_category ? ` (${c.status_category})` : ""}` +
          (c.assignee ? ` · Assignee: ${personName(c.assignee)}` : "") +
          (c.tags?.length ? ` · Tags: ${c.tags.map((t) => t.name).filter(Boolean).join(", ")}` : ""),
      ];
      if (detailed < DETAIL_LIMIT) {
        detailed += 1;
        const [messages, comments] = await Promise.all([
          client.proxy<FrontPage<FrontMessage>>({
            method: "GET",
            providerConfigKey: "front",
            connectionId,
            path: `/conversations/${c.id}/messages`,
            query: { limit: 5 },
          }),
          client.proxy<FrontPage<FrontComment>>({
            method: "GET",
            providerConfigKey: "front",
            connectionId,
            path: `/conversations/${c.id}/comments`,
          }),
        ]);
        const msgs = (messages.ok ? messages.data?._results ?? [] : []).slice(-5);
        if (msgs.length) {
          lines.push("", "Last messages:");
          for (const m of msgs) {
            const who = personName(m.author) || (m.is_inbound ? "customer" : "team");
            const body = (m.text ?? htmlToText(m.body ?? "")).trim();
            lines.push(`- ${who} (${isoFromSeconds(m.created_at) ?? ""}): ${clip(body, 1200)}`);
          }
        }
        const notes = (comments.ok ? comments.data?._results ?? [] : []).slice(-5);
        if (notes.length) {
          lines.push("", "Internal comments:");
          for (const n of notes) {
            lines.push(`- ${personName(n.author) || "teammate"} (${isoFromSeconds(n.posted_at) ?? ""}): ${clip(n.body ?? "", 1200)}`);
          }
        }
      }
      signals.push({
        external_id: `conversation:${c.id}`,
        title: c.subject?.trim() || `Conversation ${c.id}`,
        text: clip(lines.join("\n")),
        url: `https://app.frontapp.com/open/${c.id}`,
        author: personName(c.assignee) || undefined,
        at: isoFromSeconds(c.last_message?.created_at ?? c.created_at) ?? since.toISOString(),
        kind_hint: "conversation",
      });
    }
    return { signals: signals.slice(0, limit), stats: { pages, conversations: conversations.length, detailed } };
  },
};
