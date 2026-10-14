/**
 * Webflow — `webflow` → Nango `webflow` (OAuth2; proxy base
 * https://api.webflow.com, Data API v2).
 *
 * Sites the token can see (or `config.site_ids`) → every CMS collection →
 * items whose `lastUpdated` is after the cursor (the items endpoint has no
 * "since" filter, so up to 2 pages of 100 are scanned per collection), plus
 * static pages whose `lastUpdated` moved. Field data is flattened to text
 * (HTML rich-text fields stripped); links are rebuilt from the site's
 * `shortName` (`https://<shortName>.webflow.io/<collection>/<slug>`), which
 * is right for the staging domain and close enough to find the live page.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, htmlToText, str, type NangoAdapter } from "./shared";

interface WebflowSite {
  id: string;
  displayName?: string;
  shortName?: string;
  lastPublished?: string | null;
}
interface WebflowCollection {
  id: string;
  displayName?: string;
  slug?: string;
}
interface WebflowItem {
  id: string;
  lastUpdated?: string;
  lastPublished?: string | null;
  createdOn?: string;
  isDraft?: boolean;
  isArchived?: boolean;
  fieldData?: Record<string, unknown>;
}
interface WebflowPage {
  id: string;
  title?: string;
  slug?: string;
  lastUpdated?: string;
  publishedPath?: string;
  draft?: boolean;
  archived?: boolean;
  seo?: { title?: string; description?: string };
}
interface Paged<T> {
  pagination?: { limit?: number; offset?: number; total?: number };
}

/** fieldData → "key: value" lines; HTML stripped, nested objects summarised. */
export function webflowFieldsToText(fields: Record<string, unknown> | undefined): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (key === "slug" || value == null || value === "") continue;
    if (typeof value === "string") {
      const text = /<[a-z][\s\S]*>/i.test(value) ? htmlToText(value) : value;
      if (text.trim()) lines.push(`${key}: ${clip(text.trim(), 2000)}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${String(value)}`);
    } else if (Array.isArray(value)) {
      const flat = value.map((v) => (typeof v === "string" ? v : (v as { name?: string; url?: string })?.name ?? (v as { url?: string })?.url ?? "")).filter(Boolean);
      if (flat.length) lines.push(`${key}: ${flat.join(", ")}`);
    } else if (typeof value === "object") {
      const o = value as { url?: string; name?: string; alt?: string };
      const summary = o.name ?? o.url ?? o.alt;
      if (summary) lines.push(`${key}: ${summary}`);
    }
  }
  return lines.join("\n");
}

export function webflowItemUrl(site: WebflowSite, collection: WebflowCollection, item: WebflowItem): string | undefined {
  const slug = str(item.fieldData?.slug);
  if (!site.shortName || !collection.slug || !slug) return undefined;
  return `https://${site.shortName}.webflow.io/${collection.slug}/${slug}`;
}

const after = (iso: string | undefined | null, since: Date) => !!iso && new Date(iso) > since;

export const webflowAdapter: NangoAdapter = {
  id: "webflow",
  provider: "webflow",
  sourceHint: "webflow:cms",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const sitesRes = await client.proxy<{ sites?: WebflowSite[] }>({ method: "GET", providerConfigKey: "webflow", connectionId, path: "/v2/sites" });
    if (!sitesRes.ok) throw new Error(`webflow sites failed (${sitesRes.status})`);
    const wanted = allowList(config, "site_ids");
    const sites = (sitesRes.data?.sites ?? []).filter((s) => !wanted || wanted.includes(s.id) || (s.shortName ? wanted.includes(s.shortName) : false)).slice(0, 5);
    const signals: IngestSignal[] = [];
    const stats = { sites: sites.length, collections: 0, items: 0, pages: 0 };

    for (const site of sites) {
      const colRes = await client.proxy<{ collections?: WebflowCollection[] }>({ method: "GET", providerConfigKey: "webflow", connectionId, path: `/v2/sites/${site.id}/collections` });
      if (!colRes.ok) throw new Error(`webflow collections failed (${colRes.status})`);
      const collections = (colRes.data?.collections ?? []).slice(0, 20);
      stats.collections += collections.length;
      for (const collection of collections) {
        for (let offset = 0; offset < 200 && signals.length < limit; offset += 100) {
          const itemsRes = await client.proxy<{ items?: WebflowItem[] } & Paged<WebflowItem>>({
            method: "GET",
            providerConfigKey: "webflow",
            connectionId,
            path: `/v2/collections/${collection.id}/items`,
            query: { limit: 100, offset },
          });
          if (!itemsRes.ok) throw new Error(`webflow items failed (${itemsRes.status})`);
          const items = itemsRes.data?.items ?? [];
          for (const item of items) {
            if (item.isArchived || !after(item.lastUpdated, since)) continue;
            stats.items += 1;
            const name = str(item.fieldData?.name) || item.id;
            const state = item.isDraft ? "draft" : item.lastPublished && after(item.lastPublished, since) ? "published" : "updated";
            signals.push({
              external_id: `item:${collection.id}:${item.id}`,
              title: `${collection.displayName ?? collection.slug ?? "CMS"} · ${name}`,
              text: clip([`Site: ${site.displayName ?? site.shortName ?? site.id} · Collection: ${collection.displayName ?? collection.slug ?? collection.id} · State: ${state}`, "", webflowFieldsToText(item.fieldData)].join("\n")),
              url: webflowItemUrl(site, collection, item),
              at: item.lastUpdated,
              kind_hint: "cms_item",
            });
            if (signals.length >= limit) break;
          }
          const total = itemsRes.data?.pagination?.total ?? items.length;
          if (offset + 100 >= total || items.length < 100) break;
        }
        if (signals.length >= limit) break;
      }
      if (signals.length >= limit) break;

      const pagesRes = await client.proxy<{ pages?: WebflowPage[] }>({ method: "GET", providerConfigKey: "webflow", connectionId, path: `/v2/sites/${site.id}/pages`, query: { limit: 100 } });
      if (pagesRes.ok) {
        for (const page of pagesRes.data?.pages ?? []) {
          if (page.archived || !after(page.lastUpdated, since)) continue;
          stats.pages += 1;
          signals.push({
            external_id: `page:${page.id}`,
            title: `Page · ${page.title ?? page.slug ?? page.id}`,
            text: [
              `Site: ${site.displayName ?? site.shortName ?? site.id} · Page ${page.draft ? "draft" : "updated"}${page.publishedPath ? ` · Path: ${page.publishedPath}` : ""}`,
              page.seo?.title ? `SEO title: ${page.seo.title}` : null,
              page.seo?.description ? `SEO description: ${page.seo.description}` : null,
            ]
              .filter((l): l is string => l !== null)
              .join("\n"),
            url: site.shortName && page.publishedPath ? `https://${site.shortName}.webflow.io${page.publishedPath}` : undefined,
            at: page.lastUpdated,
            kind_hint: "page",
          });
          if (signals.length >= limit) break;
        }
      }
    }
    return { signals: signals.slice(0, limit), stats };
  },
};
