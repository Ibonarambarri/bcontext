/**
 * Confluence — `confluence` → Nango `confluence-basic` (BASIC: email + API
 * token; connection_config.subdomain). Pages by modified date (newest
 * first) through the v2 pages API; stops at the first page older than the
 * cursor.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, htmlToText, subdomain, type NangoAdapter } from "./shared";

interface ConfluencePage {
  id: string;
  title?: string;
  spaceId?: string;
  version?: { createdAt?: string; authorId?: string; number?: number };
  body?: { storage?: { value?: string } };
  _links?: { webui?: string };
}

export const confluenceAdapter: NangoAdapter = {
  id: "confluence",
  provider: "confluence-basic",
  sourceHint: "confluence:pages",
  async fetchChanges({ client, connectionId, connectionConfig, config, since, limit }) {
    const spaces = allowList(config, "spaces");
    const signals: IngestSignal[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await client.proxy<{ results?: ConfluencePage[]; _links?: { next?: string } }>({
        method: "GET",
        providerConfigKey: "confluence",
        connectionId,
        path: "/wiki/api/v2/pages",
        query: {
          sort: "-modified-date",
          limit: Math.min(50, limit),
          "body-format": "storage",
          ...(spaces ? { "space-id": spaces.join(",") } : {}),
          ...(cursor ? { cursor } : {}),
        },
      });
      if (!res.ok) throw new Error(`confluence pages failed (${res.status})`);
      let sawOlder = false;
      for (const page of res.data?.results ?? []) {
        const at = page.version?.createdAt;
        if (at && new Date(at) <= since) {
          sawOlder = true;
          continue;
        }
        const base = subdomain(connectionConfig) ? `https://${subdomain(connectionConfig)}.atlassian.net/wiki` : "";
        signals.push({
          external_id: `page:${page.id}`,
          title: page.title ?? `Page ${page.id}`,
          text: htmlToText(page.body?.storage?.value ?? ""),
          url: base && page._links?.webui ? `${base}${page._links.webui}` : undefined,
          at,
          kind_hint: "page",
        });
      }
      const next = res.data?._links?.next;
      cursor = next ? new URL(next, "https://x").searchParams.get("cursor") ?? undefined : undefined;
      pages += 1;
      if (sawOlder) break;
    } while (cursor && signals.length < limit && pages < 5);
    return { signals: signals.slice(0, limit), stats: { pages } };
  },
};
