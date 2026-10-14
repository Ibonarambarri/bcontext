/**
 * Box — `box` → Nango `box` (OAuth2; proxy base https://api.box.com).
 * Files updated after the cursor via `GET /2.0/search` with
 * `updated_at_range=<since>,` (open-ended), `type=file`, newest first,
 * optionally under `config.folders` (`ancestor_folder_ids`). The newest
 * files also get their comments (`/2.0/files/{id}/comments`). One signal
 * per file. The enterprise event stream (`/2.0/events?stream_type=changes`)
 * would be more precise but needs admin scopes, so search is the default.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, type NangoAdapter } from "./shared";

interface BoxUser {
  name?: string;
  login?: string;
}

interface BoxFile {
  id: string;
  type?: string;
  name?: string;
  description?: string;
  size?: number;
  modified_at?: string;
  modified_by?: BoxUser;
  created_by?: BoxUser;
  shared_link?: { url?: string } | null;
  path_collection?: { entries?: Array<{ name?: string }> };
  parent?: { id?: string; name?: string } | null;
}

interface BoxComment {
  id: string;
  message?: string;
  created_at?: string;
  created_by?: BoxUser;
}

interface BoxList<T> {
  entries?: T[];
  total_count?: number;
  offset?: number;
  limit?: number;
}

export const BOX_FILE_FIELDS = "name,description,size,modified_at,modified_by,created_by,shared_link,path_collection,parent";
const COMMENTS_MAX_FILES = 20;
const MAX_PAGES = 4;

export function boxSinceRange(since: Date): string {
  return `${since.toISOString().replace(/\.\d{3}Z$/, "Z")},`;
}

export const boxAdapter: NangoAdapter = {
  id: "box",
  provider: "box",
  sourceHint: "box:files",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const folders = allowList(config, "folders");
    const signals: IngestSignal[] = [];
    const stats = { files: 0, comments: 0 };
    const pageSize = Math.min(100, limit);
    let offset = 0;
    let pages = 0;
    let commentsFetched = 0;

    for (;;) {
      const res = await client.proxy<BoxList<BoxFile>>({
        method: "GET",
        providerConfigKey: "box",
        connectionId,
        path: "/2.0/search",
        query: {
          query: "",
          type: "file",
          updated_at_range: boxSinceRange(since),
          sort: "modified_at",
          direction: "DESC",
          fields: BOX_FILE_FIELDS,
          limit: pageSize,
          offset,
          ...(folders ? { ancestor_folder_ids: folders.join(",") } : {}),
        },
      });
      if (!res.ok) throw new Error(`box search failed (${res.status})`);
      const files = res.data?.entries ?? [];
      for (const f of files) {
        if (!f.modified_at || new Date(f.modified_at) <= since) continue;
        stats.files++;
        let comments = "";
        if (commentsFetched < COMMENTS_MAX_FILES) {
          commentsFetched++;
          const c = await client.proxy<BoxList<BoxComment>>({
            method: "GET",
            providerConfigKey: "box",
            connectionId,
            path: `/2.0/files/${encodeURIComponent(f.id)}/comments`,
            query: { limit: 20 },
          });
          if (c.ok && c.data?.entries?.length) {
            stats.comments += c.data.entries.length;
            comments = c.data.entries
              .slice(-5)
              .map((x) => `- ${x.created_by?.name ?? "someone"} (${x.created_at ?? ""}): ${x.message ?? ""}`)
              .join("\n");
          }
        }
        const folderPath = (f.path_collection?.entries ?? [])
          .map((e) => e.name)
          .filter(Boolean)
          .join(" / ");
        signals.push({
          external_id: `file:${f.id}`,
          title: f.name ?? `Box file ${f.id}`,
          text: [
            folderPath ? `Folder: ${folderPath}` : f.parent?.name ? `Folder: ${f.parent.name}` : null,
            `Modified: ${f.modified_at}${f.modified_by?.name ? ` by ${f.modified_by.name}` : ""}`,
            f.size !== undefined ? `Size: ${f.size} bytes` : null,
            f.description ? `\n${f.description}` : null,
            comments ? `\nComments:\n${comments}` : null,
            "\n(File content is not fetched; open the link to read it.)",
          ]
            .filter(Boolean)
            .join("\n"),
          url: f.shared_link?.url ?? `https://app.box.com/file/${f.id}`,
          author: f.modified_by?.name ?? f.created_by?.name,
          at: f.modified_at,
          kind_hint: "file",
        });
        if (signals.length >= limit) break;
      }
      pages++;
      offset += files.length;
      const total = res.data?.total_count ?? 0;
      if (signals.length >= limit || files.length < pageSize || offset >= total || pages >= MAX_PAGES) break;
    }

    return { signals: signals.slice(0, limit), stats };
  },
};
