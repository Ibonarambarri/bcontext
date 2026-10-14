/**
 * OneDrive — `onedrive` → Nango `one-drive` (alias of the `microsoft`
 * OAuth2 provider; proxy base https://graph.microsoft.com).
 *
 * "What changed since" without holding a delta token (adapters are
 * stateless): `/me/drive/recent` lists the items the account touched most
 * recently, filtered client-side by `lastModifiedDateTime`. When
 * `folder_ids` is set, each folder's children are listed newest-first
 * instead. Text-like files (txt, md, csv, json, log) up to 200 KB are
 * downloaded so NEXO reads the content; Office binaries keep name, path
 * and editor only.
 *
 * Install config: `folder_ids` (allow-list of drive item ids).
 * Scope: Files.Read.All.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import type { NangoClient } from "@/lib/nango/client";
import { graphIdentity, graphWalk } from "./graph";
import { allowList, clip, type NangoAdapter } from "./shared";

export interface DriveItem {
  id: string;
  name?: string;
  size?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  lastModifiedBy?: unknown;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  parentReference?: { path?: string; driveId?: string };
  remoteItem?: DriveItem;
  description?: string;
}

const KEY = "onedrive";
export const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "json", "log", "yaml", "yml"]);
export const TEXT_MAX_BYTES = 200_000;
const MAX_DOWNLOADS = 20;

export function isTextLike(item: DriveItem): boolean {
  const ext = (item.name ?? "").split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.has(ext) && (item.size ?? 0) <= TEXT_MAX_BYTES && !!item.file;
}

export function driveItemPath(item: DriveItem): string {
  const p = item.parentReference?.path ?? "";
  const clean = p.replace(/^\/drive\/root:/, "").replace(/^\/drives\/[^/]+\/root:/, "");
  return `${clean}/${item.name ?? ""}`.replace(/\/+/g, "/");
}

export async function driveItemText(
  client: NangoClient,
  providerConfigKey: string,
  connectionId: string,
  itemPath: string,
): Promise<string> {
  const res = await client.proxy<string>({ method: "GET", providerConfigKey, connectionId, path: `${itemPath}/content` });
  return res.ok && typeof res.data === "string" ? res.data : "";
}

/** Shared by OneDrive and SharePoint: list newest-first, keep items modified after `since`. */
export async function collectDriveItems(args: {
  client: NangoClient;
  providerConfigKey: string;
  connectionId: string;
  sources: Array<{ listPath: string; query: Record<string, string | number | boolean | undefined>; itemPathFor: (item: DriveItem) => string }>;
  since: Date;
  limit: number;
  signals: IngestSignal[];
  stats: Record<string, number>;
  label: string;
}): Promise<void> {
  const { client, providerConfigKey, connectionId, since, limit, signals, stats } = args;
  const seen = new Set(signals.map((s) => s.external_id));
  let downloads = 0;
  for (const source of args.sources) {
    const fresh: Array<{ item: DriveItem; itemPath: string }> = [];
    const { pages } = await graphWalk<DriveItem>(client, providerConfigKey, connectionId, source.listPath, source.query, (raw) => {
      const item = raw.remoteItem ? { ...raw.remoteItem, name: raw.name ?? raw.remoteItem.name, webUrl: raw.webUrl ?? raw.remoteItem.webUrl } : raw;
      if (item.folder) return true;
      const at = item.lastModifiedDateTime ? Date.parse(item.lastModifiedDateTime) : NaN;
      if (Number.isNaN(at) || at <= since.getTime()) { stats.skipped = (stats.skipped ?? 0) + 1; return true; }
      if (seen.has(`item:${item.id}`)) return true;
      seen.add(`item:${item.id}`);
      fresh.push({ item, itemPath: source.itemPathFor(item) });
      return signals.length + fresh.length < limit;
    }, { maxPages: 3 });
    stats.pages = (stats.pages ?? 0) + pages;
    for (const { item, itemPath } of fresh) {
      let body = item.description ?? "";
      if (isTextLike(item) && downloads < MAX_DOWNLOADS) {
        downloads += 1;
        const text = await driveItemText(client, providerConfigKey, connectionId, itemPath);
        if (text) body = text;
      }
      const editor = graphIdentity(item.lastModifiedBy);
      signals.push({
        external_id: `item:${item.id}`,
        title: item.name ?? item.id,
        text: [
          `${args.label}: ${driveItemPath(item)}${item.file?.mimeType ? ` · Type: ${item.file.mimeType}` : ""}${editor ? ` · Last edited by: ${editor}` : ""}`,
          "",
          clip(body, 200_000),
        ].join("\n"),
        url: item.webUrl,
        author: editor,
        at: item.lastModifiedDateTime,
        kind_hint: body ? "document" : "file",
      });
      if (signals.length >= limit) break;
    }
    stats.downloads = downloads;
    if (signals.length >= limit) break;
  }
}

export const onedriveAdapter: NangoAdapter = {
  id: KEY,
  provider: "one-drive",
  sourceHint: "onedrive:files",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const folderIds = allowList(config, "folder_ids");
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = {};
    const sources = folderIds
      ? folderIds.slice(0, 10).map((id) => ({
          listPath: `/v1.0/me/drive/items/${encodeURIComponent(id)}/children`,
          query: { $orderby: "lastModifiedDateTime desc", $top: Math.min(50, limit) },
          itemPathFor: (item: DriveItem) => `/v1.0/me/drive/items/${encodeURIComponent(item.id)}`,
        }))
      : [
          {
            listPath: "/v1.0/me/drive/recent",
            query: { $top: Math.min(50, limit) },
            itemPathFor: (item: DriveItem) =>
              item.parentReference?.driveId
                ? `/v1.0/drives/${encodeURIComponent(item.parentReference.driveId)}/items/${encodeURIComponent(item.id)}`
                : `/v1.0/me/drive/items/${encodeURIComponent(item.id)}`,
          },
        ];
    await collectDriveItems({ client, providerConfigKey: KEY, connectionId, sources, since, limit, signals, stats, label: "Path" });
    return { signals: signals.slice(0, limit), stats };
  },
};
