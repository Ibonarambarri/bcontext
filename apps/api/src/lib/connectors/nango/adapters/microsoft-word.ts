/**
 * Microsoft Word — `microsoft-word` → Nango `microsoft-word` (alias of the
 * `microsoft` OAuth2 provider; proxy base https://graph.microsoft.com).
 *
 * `.docx` files modified after the cursor (Graph search over the drive, or
 * the children of `config.folder_ids`) are downloaded through the proxy
 * (`/items/{id}/content`, ≤ 2 MB) and read in-process: `word/document.xml`
 * is pulled out of the zip and flattened to paragraphs — no dependency,
 * see `./ms-office.ts`. Larger or unreadable files still produce a signal
 * with name, path and editor so NEXO knows something changed.
 *
 * Install config: `folder_ids`. Scope: Files.Read.All.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { graphIdentity } from "./graph";
import { docxToText, itemPathFor, listOfficeFiles, OFFICE_MAX_BYTES } from "./ms-office";
import { driveItemPath } from "./onedrive";
import { allowList, clip, type NangoAdapter } from "./shared";

const KEY = "microsoft-word";
const MAX_DOWNLOADS = 20;

export const microsoftWordAdapter: NangoAdapter = {
  id: KEY,
  provider: "microsoft-word",
  sourceHint: "microsoft-word:documents",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const stats: Record<string, number> = { skipped: 0, downloads: 0 };
    const items = await listOfficeFiles({
      client,
      providerConfigKey: KEY,
      connectionId,
      extension: "docx",
      folderIds: allowList(config, "folder_ids"),
      since,
      limit,
      stats,
    });
    const signals: IngestSignal[] = [];
    let downloads = 0;
    for (const item of items) {
      let body = "";
      if ((item.size ?? 0) <= OFFICE_MAX_BYTES && downloads < MAX_DOWNLOADS) {
        downloads += 1;
        const res = await client.proxy<Buffer>({
          method: "GET",
          providerConfigKey: KEY,
          connectionId,
          path: `${itemPathFor(item)}/content`,
          responseType: "buffer",
        });
        if (res.ok && Buffer.isBuffer(res.data)) body = docxToText(res.data);
      }
      const editor = graphIdentity(item.lastModifiedBy);
      signals.push({
        external_id: `doc:${item.id}`,
        title: item.name ?? item.id,
        text: clip(
          [
            `Document: ${driveItemPath(item)}${editor ? ` · Last edited by: ${editor}` : ""}${item.size ? ` · ${Math.round(item.size / 1024)} KB` : ""}`,
            "",
            body || "(content not extracted — file too large or not a readable .docx)",
          ].join("\n"),
          20_000,
        ),
        url: item.webUrl,
        author: editor,
        at: item.lastModifiedDateTime,
        kind_hint: "document",
      });
      if (signals.length >= limit) break;
    }
    stats.downloads = downloads;
    return { signals: signals.slice(0, limit), stats };
  },
};
