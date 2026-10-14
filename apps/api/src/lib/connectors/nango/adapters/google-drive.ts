/**
 * Google Drive — `google-drive` → Nango `google-drive` (OAuth2 via the
 * `google` provider; proxy base https://www.googleapis.com). Files modified
 * since the cursor through Drive v3 `files.list`; Google-native documents
 * (Docs / Sheets / Slides) are exported as text so NEXO reads the content,
 * binaries keep their name + description only.
 *
 * Install config: `folder_ids` (allow-list of folder ids; default = every
 * file the account can see, shared drives included).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, type NangoAdapter } from "./shared";

interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  webViewLink?: string;
  description?: string;
  size?: string;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
  lastModifyingUser?: { displayName?: string; emailAddress?: string };
}

/** Google-native mime → export mime. Anything else is not exported. */
export const DRIVE_EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

/** Exported text above this many chars is clipped — one slide deck must not eat the batch. */
export const DRIVE_EXPORT_MAX_CHARS = 200_000;

export function driveQuery(since: Date, folderIds: string[] | null): string {
  const parts = [`modifiedTime > '${since.toISOString()}'`, "trashed = false"];
  if (folderIds) parts.push(`(${folderIds.map((id) => `'${id.replace(/'/g, "")}' in parents`).join(" or ")})`);
  return parts.join(" and ");
}

export const googleDriveAdapter: NangoAdapter = {
  id: "google-drive",
  provider: "google-drive",
  sourceHint: "google-drive:files",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const folderIds = allowList(config, "folder_ids");
    const signals: IngestSignal[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    let exported = 0;
    do {
      const res = await client.proxy<{ files?: DriveFile[]; nextPageToken?: string }>({
        method: "GET",
        providerConfigKey: "google-drive",
        connectionId,
        path: "/drive/v3/files",
        query: {
          q: driveQuery(since, folderIds),
          orderBy: "modifiedTime desc",
          pageSize: Math.min(50, limit),
          fields: "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,description,size,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress))",
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          ...(pageToken ? { pageToken } : {}),
        },
      });
      if (!res.ok) throw new Error(`google drive files.list failed (${res.status})`);
      for (const file of res.data?.files ?? []) {
        const exportMime = file.mimeType ? DRIVE_EXPORTS[file.mimeType] : undefined;
        let body = file.description ?? "";
        if (exportMime && exported < 20) {
          exported += 1;
          const exp = await client.proxy<string>({
            method: "GET",
            providerConfigKey: "google-drive",
            connectionId,
            path: `/drive/v3/files/${encodeURIComponent(file.id)}/export`,
            query: { mimeType: exportMime },
          });
          if (exp.ok && typeof exp.data === "string") body = clip(exp.data, DRIVE_EXPORT_MAX_CHARS);
        }
        const editor = file.lastModifyingUser?.displayName ?? file.owners?.[0]?.displayName;
        signals.push({
          external_id: `file:${file.id}`,
          title: file.name ?? file.id,
          text: [
            `Type: ${file.mimeType ?? "?"}${editor ? ` · Last edited by: ${editor}` : ""}`,
            "",
            body,
          ].join("\n"),
          url: file.webViewLink,
          author: editor,
          at: file.modifiedTime,
          kind_hint: exportMime ? "document" : "file",
        });
        if (signals.length >= limit) break;
      }
      pageToken = res.data?.nextPageToken;
      pages += 1;
    } while (pageToken && signals.length < limit && pages < 5);
    return { signals: signals.slice(0, limit), stats: { pages, exported } };
  },
};
