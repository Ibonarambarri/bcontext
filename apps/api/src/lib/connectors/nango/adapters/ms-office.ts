/**
 * Shared helpers for the Office-file adapters (Word, Excel): find the
 * `.docx` / `.xlsx` items an account modified since the cursor through
 * Microsoft Graph, and read `.docx` text without a dependency.
 *
 * Listing: `/me/drive/root/search(q='.docx')` returns every item whose name
 * matches, newest-first is not guaranteed, so pages are walked (cap 3) and
 * filtered client-side on `lastModifiedDateTime`. With `folder_ids` the
 * folders' children are listed instead (`$orderby=lastModifiedDateTime desc`).
 *
 * The item path for downloads/workbook calls goes through the drive the
 * item lives in when Graph tells us (`parentReference.driveId`) — shared
 * libraries surface in search results with a different drive id.
 */
import { inflateRawSync } from "node:zlib";
import type { NangoClient } from "@/lib/nango/client";
import { graphWalk } from "./graph";
import type { DriveItem } from "./onedrive";

export const OFFICE_MAX_BYTES = 2_000_000;

export function itemPathFor(item: DriveItem): string {
  return item.parentReference?.driveId
    ? `/v1.0/drives/${encodeURIComponent(item.parentReference.driveId)}/items/${encodeURIComponent(item.id)}`
    : `/v1.0/me/drive/items/${encodeURIComponent(item.id)}`;
}

/** Items with the extension modified strictly after `since`, newest first, capped. */
export async function listOfficeFiles(args: {
  client: NangoClient;
  providerConfigKey: string;
  connectionId: string;
  extension: "docx" | "xlsx";
  folderIds: string[] | null;
  since: Date;
  limit: number;
  stats: Record<string, number>;
}): Promise<DriveItem[]> {
  const { client, providerConfigKey, connectionId, extension, since, limit, stats } = args;
  const sources = args.folderIds
    ? args.folderIds.slice(0, 10).map((id) => ({
        path: `/v1.0/me/drive/items/${encodeURIComponent(id)}/children`,
        query: { $orderby: "lastModifiedDateTime desc", $top: 50 } as Record<string, string | number | boolean | undefined>,
      }))
    : [{ path: `/v1.0/me/drive/root/search(q='.${extension}')`, query: { $top: 50 } as Record<string, string | number | boolean | undefined> }];
  const seen = new Set<string>();
  const fresh: DriveItem[] = [];
  for (const source of sources) {
    const { pages } = await graphWalk<DriveItem>(client, providerConfigKey, connectionId, source.path, source.query, (raw) => {
      const item = raw.remoteItem ? { ...raw.remoteItem, name: raw.name ?? raw.remoteItem.name, webUrl: raw.webUrl ?? raw.remoteItem.webUrl } : raw;
      if (item.folder || !item.file) return true;
      const ext = (item.name ?? "").split(".").pop()?.toLowerCase();
      if (ext !== extension) return true;
      const at = item.lastModifiedDateTime ? Date.parse(item.lastModifiedDateTime) : NaN;
      if (Number.isNaN(at) || at <= since.getTime()) {
        stats.skipped = (stats.skipped ?? 0) + 1;
        return true;
      }
      if (seen.has(item.id)) return true;
      seen.add(item.id);
      fresh.push(item);
      return fresh.length < limit;
    }, { maxPages: 3 });
    stats.pages = (stats.pages ?? 0) + pages;
    if (fresh.length >= limit) break;
  }
  fresh.sort((a, b) => Date.parse(b.lastModifiedDateTime ?? "") - Date.parse(a.lastModifiedDateTime ?? ""));
  return fresh.slice(0, limit);
}

// -- .docx text without a dependency -------------------------------------------

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Extract one entry (by exact name) from a zip Buffer; null when absent/unsupported. */
export function zipEntry(buf: Buffer, entryName: string): Buffer | null {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entries = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CD_SIG) return null;
    const method = buf.readUInt16LE(offset + 10);
    const compressed = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    if (name === entryName) {
      if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) return null;
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compressed);
      if (method === 0) return Buffer.from(data);
      if (method === 8) {
        try {
          return inflateRawSync(data);
        } catch {
          return null;
        }
      }
      return null;
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** WordprocessingML → plain text: paragraphs become lines, tabs/breaks kept, tags dropped. */
export function documentXmlToText(xml: string): string {
  return xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\/>|<w:cr\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tc>/g, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function docxToText(buf: Buffer): string {
  const xml = zipEntry(buf, "word/document.xml");
  return xml ? documentXmlToText(xml.toString("utf8")) : "";
}
