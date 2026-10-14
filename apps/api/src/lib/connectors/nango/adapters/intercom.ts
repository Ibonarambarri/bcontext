/**
 * Intercom — `intercom` → Nango `intercom` (OAuth2; proxy base
 * https://api.<region>.intercom.io, region from connection_config).
 * Conversations updated since the cursor (`POST /conversations/search`,
 * then `GET /conversations/{id}` for the parts), flattened as a dialogue,
 * plus Help Center articles updated since (`GET /articles`, filtered
 * client-side — the endpoint has no `updated_since`). API version 2.11.
 *
 * `config.app_id` (optional) makes conversation links deep-link into the
 * inbox; without it conversations carry no URL.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { clip, configString, epochSeconds, htmlToText, type NangoAdapter } from "./shared";

export const INTERCOM_VERSION = "2.11";

interface IcAuthor {
  type?: string;
  name?: string | null;
  email?: string | null;
}

interface IcPart {
  id?: string;
  part_type?: string;
  body?: string | null;
  author?: IcAuthor;
  created_at?: number;
}

interface IcConversation {
  id: string;
  title?: string | null;
  state?: string;
  created_at?: number;
  updated_at?: number;
  source?: { subject?: string | null; body?: string | null; author?: IcAuthor };
  conversation_parts?: { conversation_parts?: IcPart[] };
  tags?: { tags?: Array<{ name?: string }> };
}

interface IcArticle {
  id: string;
  title?: string;
  body?: string | null;
  url?: string | null;
  state?: string;
  updated_at?: number;
  author_id?: number;
}

const HEADERS = { "Intercom-Version": INTERCOM_VERSION };

function iso(epoch?: number): string | undefined {
  return typeof epoch === "number" ? new Date(epoch * 1000).toISOString() : undefined;
}

export const intercomAdapter: NangoAdapter = {
  id: "intercom",
  provider: "intercom",
  sourceHint: "intercom:conversations",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const appId = configString(config, "app_id");
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = { conversations: 0, articles: 0 };

    const search = await client.proxy<{ conversations?: IcConversation[] }>({
      method: "POST",
      providerConfigKey: "intercom",
      connectionId,
      path: "/conversations/search",
      headers: HEADERS,
      body: {
        query: { field: "updated_at", operator: ">", value: epochSeconds(since) },
        pagination: { per_page: Math.min(50, limit) },
      },
    });
    if (!search.ok) throw new Error(`intercom conversations search failed (${search.status})`);
    for (const hit of search.data?.conversations ?? []) {
      const full = await client.proxy<IcConversation>({
        method: "GET",
        providerConfigKey: "intercom",
        connectionId,
        path: `/conversations/${hit.id}`,
        headers: HEADERS,
      });
      const c = full.ok ? full.data : hit;
      const opening = c.source?.body ? `${c.source.author?.name ?? "customer"}: ${htmlToText(c.source.body)}` : null;
      const parts = (c.conversation_parts?.conversation_parts ?? [])
        .filter((p) => p.body)
        .map((p) => `${p.author?.name ?? p.author?.type ?? "someone"}: ${htmlToText(p.body ?? "")}`);
      const tags = (c.tags?.tags ?? []).map((t) => t.name).filter(Boolean).join(", ");
      signals.push({
        external_id: `conversation:${c.id}`,
        title: c.title ?? c.source?.subject ?? `Conversation ${c.id}`,
        text: clip([`State: ${c.state ?? "?"}${tags ? ` · Tags: ${tags}` : ""}`, "", opening, ...parts].filter((l) => l !== null).join("\n")),
        url: appId ? `https://app.intercom.com/a/apps/${appId}/inbox/conversation/${c.id}` : undefined,
        author: c.source?.author?.name ?? undefined,
        at: iso(c.updated_at),
        kind_hint: "conversation",
      });
      stats.conversations = (stats.conversations ?? 0) + 1;
      if (signals.length >= limit) break;
    }

    if (signals.length < limit) {
      const articles = await client.proxy<{ data?: IcArticle[] }>({
        method: "GET",
        providerConfigKey: "intercom",
        connectionId,
        path: "/articles",
        headers: HEADERS,
        query: { per_page: 50 },
      });
      if (articles.ok) {
        const cutoff = epochSeconds(since);
        for (const a of articles.data?.data ?? []) {
          if ((a.updated_at ?? 0) <= cutoff) continue;
          signals.push({
            external_id: `article:${a.id}`,
            title: a.title ?? `Article ${a.id}`,
            text: clip([`State: ${a.state ?? "?"}`, "", htmlToText(a.body ?? "")].join("\n")),
            url: a.url ?? undefined,
            at: iso(a.updated_at),
            kind_hint: "article",
          });
          stats.articles = (stats.articles ?? 0) + 1;
          if (signals.length >= limit) break;
        }
      }
    }
    return { signals: signals.slice(0, limit), stats };
  },
};
