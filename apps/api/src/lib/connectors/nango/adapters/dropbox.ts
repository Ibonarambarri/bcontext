/**
 * Dropbox — `dropbox` → Nango `dropbox` (OAuth2; proxy base
 * https://api.dropboxapi.com). Walks `config.folders` (default: the root)
 * with `POST /2/files/list_folder` (recursive) and
 * `/2/files/list_folder/continue`, keeping files whose `server_modified`
 * is after the cursor. One signal per changed file: name, path, size,
 * modifier, and a link into the Dropbox web app.
 *
 * Dropbox's own delta cursor would be the exact "since", but adapters
 * cannot persist state between runs, so the listing is re-walked and
 * filtered by time (pages capped). File bodies live on
 * content.dropboxapi.com, a host the proxy does not front, so contents are
 * not fetched — NEXO learns which documents moved and where they are.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, type NangoAdapter } from "./shared";

interface DropboxEntry {
  ".tag": "file" | "folder" | "deleted";
  id?: string;
  name?: string;
  path_display?: string;
  path_lower?: string;
  server_modified?: string;
  client_modified?: string;
  size?: number;
  rev?: string;
  sharing_info?: { modified_by?: string };
}

interface ListFolderResult {
  entries?: DropboxEntry[];
  cursor?: string;
  has_more?: boolean;
}

const MAX_PAGES_PER_FOLDER = 5;

function webLink(pathLower: string | undefined): string | undefined {
  if (!pathLower) return undefined;
  return `https://www.dropbox.com/home${pathLower
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/")}`;
}

export const dropboxAdapter: NangoAdapter = {
  id: "dropbox",
  provider: "dropbox",
  sourceHint: "dropbox:files",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const folders = allowList(config, "folders") ?? [""];
    const signals: IngestSignal[] = [];
    const stats = { entries: 0, files: 0 };

    for (const folder of folders.slice(0, 10)) {
      const path = folder === "/" ? "" : folder;
      let res = await client.proxy<ListFolderResult>({
        method: "POST",
        providerConfigKey: "dropbox",
        connectionId,
        path: "/2/files/list_folder",
        body: { path, recursive: true, include_deleted: false, include_non_downloadable_files: true, limit: 2000 },
      });
      let pages = 0;
      for (;;) {
        if (!res.ok) throw new Error(`dropbox list_folder failed (${res.status})`);
        const entries = res.data?.entries ?? [];
        stats.entries += entries.length;
        for (const e of entries) {
          if (e[".tag"] !== "file" || !e.server_modified || new Date(e.server_modified) <= since) continue;
          stats.files++;
          signals.push({
            external_id: `file:${e.id ?? e.path_lower ?? e.name}`,
            title: e.name ?? e.path_display ?? "Dropbox file",
            text: [
              `Path: ${e.path_display ?? e.path_lower ?? "?"}`,
              `Modified: ${e.server_modified}${e.sharing_info?.modified_by ? ` by ${e.sharing_info.modified_by}` : ""}`,
              e.size !== undefined ? `Size: ${e.size} bytes` : null,
              e.rev ? `Revision: ${e.rev}` : null,
              "\n(File content is not fetched; open the link to read it.)",
            ]
              .filter(Boolean)
              .join("\n"),
            url: webLink(e.path_lower),
            author: e.sharing_info?.modified_by,
            at: e.server_modified,
            kind_hint: "file",
          });
          if (signals.length >= limit) break;
        }
        pages++;
        if (signals.length >= limit || !res.data?.has_more || !res.data.cursor || pages >= MAX_PAGES_PER_FOLDER) break;
        res = await client.proxy<ListFolderResult>({
          method: "POST",
          providerConfigKey: "dropbox",
          connectionId,
          path: "/2/files/list_folder/continue",
          body: { cursor: res.data.cursor },
        });
      }
      if (signals.length >= limit) break;
    }

    signals.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
    return { signals: signals.slice(0, limit), stats };
  },
};
