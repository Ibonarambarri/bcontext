/**
 * Notion (via Nango) — `notion-nango` → Nango `notion` (OAuth2 public
 * integration; proxy base https://api.notion.com; header
 * `Notion-Version: 2022-06-28`).
 *
 * The Nango-backed twin of the native `notion` connector (one-shot import).
 * This one re-reads what changed each cadence:
 *   POST /v1/search { filter: page, sort: last_edited_time desc, page_size: 50 }
 *       newest-first, stops at the first page with last_edited_time <= since (≤4 pages)
 *   POST /v1/databases/{id}/query (when `config.database_ids` is set)
 *       with a last_edited_time "after" filter, per database (≤10)
 *   GET  /v1/blocks/{id}/children?page_size=100 (≤2 pages) for the body,
 *       flattened to text (paragraphs, headings, lists, to-dos, quotes,
 *       callouts, code), capped at 20 KB
 * One signal per page (`page:<id>`).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, type NangoAdapter } from "./shared";

interface RichText {
  plain_text?: string;
}

interface NotionPage {
  id: string;
  object?: string;
  url?: string;
  created_time?: string;
  last_edited_time?: string;
  archived?: boolean;
  in_trash?: boolean;
  properties?: Record<string, { type?: string; title?: RichText[] }>;
  parent?: { type?: string; database_id?: string; page_id?: string };
}

interface NotionList<T> {
  results?: T[];
  has_more?: boolean;
  next_cursor?: string | null;
}

interface NotionBlock {
  id: string;
  type?: string;
  has_children?: boolean;
  [key: string]: unknown;
}

const SEARCH_PAGES = 4;
const BLOCK_PAGES = 2;
const BODY_READS = 40;
const DATABASES_MAX = 10;
const TEXT_TYPES = new Set(["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do", "toggle", "quote", "callout", "code"]);
const NOTION_HEADERS = { "Notion-Version": "2022-06-28" };

export function pageTitle(page: NotionPage): string {
  for (const prop of Object.values(page.properties ?? {})) {
    if (prop?.type === "title") return (prop.title ?? []).map((t) => t.plain_text ?? "").join("").trim();
  }
  return "";
}

/** One line per text block; headings and list markers kept lightweight. */
export function blocksToText(blocks: NotionBlock[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    const type = b.type ?? "";
    if (!TEXT_TYPES.has(type)) continue;
    const payload = b[type] as { rich_text?: RichText[]; checked?: boolean } | undefined;
    const text = (payload?.rich_text ?? []).map((t) => t.plain_text ?? "").join("").trim();
    if (!text) continue;
    if (type.startsWith("heading")) lines.push(`## ${text}`);
    else if (type === "bulleted_list_item" || type === "numbered_list_item") lines.push(`- ${text}`);
    else if (type === "to_do") lines.push(`- [${payload?.checked ? "x" : " "}] ${text}`);
    else if (type === "quote") lines.push(`> ${text}`);
    else lines.push(text);
  }
  return lines.join("\n");
}

export const notionNangoAdapter: NangoAdapter = {
  id: "notion-nango",
  provider: "notion",
  sourceHint: "notion:pages",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const stats: Record<string, number> & { requests: number; pages: number; bodies: number } = { requests: 0, pages: 0, bodies: 0 };
    const pages = new Map<string, NotionPage>();
    const sinceIso = since.toISOString();
    const databases = allowList(config, "database_ids");

    const post = async <T>(path: string, body: unknown) => {
      const res = await client.proxy<T>({ method: "POST", providerConfigKey: "notion-nango", connectionId, path, body, headers: NOTION_HEADERS });
      stats.requests += 1;
      if (!res.ok) throw new Error(`notion ${path} failed (${res.status})`);
      return res.data;
    };

    if (databases) {
      for (const db of databases.slice(0, DATABASES_MAX)) {
        let cursor: string | null | undefined;
        for (let page = 0; page < SEARCH_PAGES; page += 1) {
          const data = await post<NotionList<NotionPage>>(`/v1/databases/${db}/query`, {
            filter: { timestamp: "last_edited_time", last_edited_time: { after: sinceIso } },
            sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
            page_size: 50,
            ...(cursor ? { start_cursor: cursor } : {}),
          });
          for (const p of data?.results ?? []) pages.set(p.id, p);
          cursor = data?.has_more ? data.next_cursor : null;
          if (!cursor || pages.size >= limit) break;
        }
      }
    } else {
      let cursor: string | null | undefined;
      let reachedCursor = false;
      for (let page = 0; page < SEARCH_PAGES && !reachedCursor; page += 1) {
        const data = await post<NotionList<NotionPage>>("/v1/search", {
          filter: { property: "object", value: "page" },
          sort: { direction: "descending", timestamp: "last_edited_time" },
          page_size: 50,
          ...(cursor ? { start_cursor: cursor } : {}),
        });
        for (const p of data?.results ?? []) {
          if (p.last_edited_time && new Date(p.last_edited_time) <= since) {
            reachedCursor = true;
            break;
          }
          pages.set(p.id, p);
        }
        cursor = data?.has_more ? data.next_cursor : null;
        if (!cursor || pages.size >= limit) break;
      }
    }

    const signals: IngestSignal[] = [];
    for (const p of pages.values()) {
      if (signals.length >= limit) break;
      if (p.archived || p.in_trash) continue;
      if (p.last_edited_time && new Date(p.last_edited_time) <= since) continue;
      stats.pages += 1;
      let body = "";
      if (stats.bodies < BODY_READS) {
        stats.bodies += 1;
        const blocks: NotionBlock[] = [];
        let cursor: string | null | undefined;
        for (let page = 0; page < BLOCK_PAGES; page += 1) {
          const res = await client.proxy<NotionList<NotionBlock>>({
            method: "GET",
            providerConfigKey: "notion-nango",
            connectionId,
            path: `/v1/blocks/${p.id}/children`,
            query: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
            headers: NOTION_HEADERS,
          });
          stats.requests += 1;
          if (!res.ok) {
            stats.body_failed = (stats.body_failed ?? 0) + 1;
            break;
          }
          blocks.push(...(res.data?.results ?? []));
          cursor = res.data?.has_more ? res.data.next_cursor : null;
          if (!cursor) break;
        }
        body = blocksToText(blocks);
      }
      const title = pageTitle(p) || "Untitled";
      signals.push({
        external_id: `page:${p.id}`,
        title,
        text: clip(body || title, 20_000),
        url: p.url,
        at: p.last_edited_time,
        kind_hint: "page",
      });
    }

    return { signals, stats };
  },
};
