/**
 * SharePoint — `sharepoint` → Nango `sharepoint-online` (alias of the
 * `microsoft` OAuth2 provider; proxy base https://graph.microsoft.com).
 *
 * Per site: documents in the default document library modified since the
 * cursor (`/sites/{id}/drive/root/search(q='')`, newest first, filtered
 * client-side — Graph's drive search has no `$filter` on dates) and site
 * pages modified since (`/sites/{id}/pages/microsoft.graph.sitePage`).
 * Text-like documents are downloaded like OneDrive does; pages keep title
 * and description (the canvas layout is too heavy to fetch per page).
 *
 * Install config: `site_ids` (allow-list of site ids; default = the first
 * five sites `/sites?search=*` returns). Scope: Sites.Read.All.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { graphIdentity, graphWalk } from "./graph";
import { collectDriveItems, type DriveItem } from "./onedrive";
import { allowList, clip, type NangoAdapter } from "./shared";

interface Site { id: string; displayName?: string; name?: string; webUrl?: string }
interface SitePage {
  id: string;
  title?: string;
  name?: string;
  description?: string;
  webUrl?: string;
  lastModifiedDateTime?: string;
  lastModifiedBy?: unknown;
}

const KEY = "sharepoint";
const MAX_SITES = 5;

export const sharepointAdapter: NangoAdapter = {
  id: KEY,
  provider: "sharepoint-online",
  sourceHint: "sharepoint:documents",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const siteIds = allowList(config, "site_ids");
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> & { sites: number; pages_items: number } = { sites: 0, pages_items: 0 };

    const sites: Site[] = [];
    if (siteIds) {
      for (const id of siteIds.slice(0, MAX_SITES)) sites.push({ id });
    } else {
      await graphWalk<Site>(client, KEY, connectionId, "/v1.0/sites", { search: "*", $top: MAX_SITES }, (s) => {
        sites.push(s);
        return sites.length < MAX_SITES;
      }, { maxPages: 1 });
    }
    stats.sites = sites.length;

    for (const site of sites) {
      const siteId = encodeURIComponent(site.id);
      const label = site.displayName ?? site.name ?? site.id;
      await collectDriveItems({
        client,
        providerConfigKey: KEY,
        connectionId,
        since,
        limit,
        signals,
        stats,
        label: `Site ${label} · Path`,
        sources: [
          {
            listPath: `/v1.0/sites/${siteId}/drive/root/search(q='')`,
            query: { $orderby: "lastModifiedDateTime desc", $top: Math.min(50, limit) },
            itemPathFor: (item: DriveItem) =>
              item.parentReference?.driveId
                ? `/v1.0/drives/${encodeURIComponent(item.parentReference.driveId)}/items/${encodeURIComponent(item.id)}`
                : `/v1.0/sites/${siteId}/drive/items/${encodeURIComponent(item.id)}`,
          },
        ],
      });
      if (signals.length >= limit) break;

      try {
        await graphWalk<SitePage>(
          client,
          KEY,
          connectionId,
          `/v1.0/sites/${siteId}/pages/microsoft.graph.sitePage`,
          { $select: "id,title,name,description,webUrl,lastModifiedDateTime,lastModifiedBy", $top: Math.min(50, limit) },
          (p) => {
            const at = p.lastModifiedDateTime ? Date.parse(p.lastModifiedDateTime) : NaN;
            if (Number.isNaN(at) || at <= since.getTime()) return true;
            const editor = graphIdentity(p.lastModifiedBy);
            signals.push({
              external_id: `page:${site.id}:${p.id}`,
              title: p.title ?? p.name ?? p.id,
              text: [`Site page in ${label}${editor ? ` · Last edited by: ${editor}` : ""}`, "", clip(p.description ?? "")].join("\n"),
              url: p.webUrl,
              author: editor,
              at: p.lastModifiedDateTime,
              kind_hint: "page",
            });
            stats.pages_items += 1;
            return signals.length < limit;
          },
          { maxPages: 2 },
        );
      } catch {
        // Site pages need Sites.Read.All on modern sites only; documents already counted.
        stats.pages_failed = (stats.pages_failed ?? 0) + 1;
      }
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats };
  },
};
