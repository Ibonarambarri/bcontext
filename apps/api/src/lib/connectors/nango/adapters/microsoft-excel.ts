/**
 * Microsoft Excel — `microsoft-excel` → Nango `microsoft-excel` (alias of
 * the `microsoft` OAuth2 provider; proxy base https://graph.microsoft.com).
 *
 * `.xlsx` files modified after the cursor (drive search, or the children
 * of `config.folder_ids`) are read through the Excel workbook API instead
 * of being downloaded: `/workbook/worksheets` then each sheet's
 * `/usedRange?$select=values` — the first 3 sheets, first 200 rows,
 * rendered as `a | b | c` lines. One signal per sheet. Files whose
 * workbook session cannot be opened (still uploading, protected) fall
 * back to a name-only signal.
 *
 * Install config: `folder_ids`. Scope: Files.Read.All.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { graphIdentity } from "./graph";
import { valuesToText } from "./google-sheets";
import { itemPathFor, listOfficeFiles } from "./ms-office";
import { driveItemPath } from "./onedrive";
import { allowList, clip, type NangoAdapter } from "./shared";

const KEY = "microsoft-excel";
const MAX_FILES = 10;
const MAX_SHEETS = 3;
const MAX_ROWS = 200;

interface Worksheet {
  id: string;
  name?: string;
  visibility?: string;
}

export const microsoftExcelAdapter: NangoAdapter = {
  id: KEY,
  provider: "microsoft-excel",
  sourceHint: "microsoft-excel:sheets",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const stats: Record<string, number> = { skipped: 0, files: 0, sheets: 0 };
    const items = await listOfficeFiles({
      client,
      providerConfigKey: KEY,
      connectionId,
      extension: "xlsx",
      folderIds: allowList(config, "folder_ids"),
      since,
      limit: MAX_FILES,
      stats,
    });
    const signals: IngestSignal[] = [];
    for (const item of items) {
      const base = itemPathFor(item);
      const editor = graphIdentity(item.lastModifiedBy);
      const header = `Workbook: ${driveItemPath(item)}${editor ? ` · Last edited by: ${editor}` : ""}`;
      const sheets = await client.proxy<{ value?: Worksheet[] }>({ method: "GET", providerConfigKey: KEY, connectionId, path: `${base}/workbook/worksheets` });
      if (!sheets.ok) {
        stats.skipped = (stats.skipped ?? 0) + 1;
        signals.push({
          external_id: `workbook:${item.id}`,
          title: item.name ?? item.id,
          text: `${header}\n\n(workbook could not be opened — changed file, contents not read)`,
          url: item.webUrl,
          author: editor,
          at: item.lastModifiedDateTime,
          kind_hint: "sheet",
        });
        continue;
      }
      stats.files = (stats.files ?? 0) + 1;
      const visible = (sheets.data?.value ?? []).filter((w) => w.visibility !== "Hidden").slice(0, MAX_SHEETS);
      for (const ws of visible) {
        const range = await client.proxy<{ values?: unknown[][]; address?: string }>({
          method: "GET",
          providerConfigKey: KEY,
          connectionId,
          path: `${base}/workbook/worksheets/${encodeURIComponent(ws.id)}/usedRange`,
          query: { $select: "values,address", valuesOnly: true },
        });
        if (!range.ok) {
          stats.skipped = (stats.skipped ?? 0) + 1;
          continue;
        }
        const text = valuesToText((range.data?.values ?? []).slice(0, MAX_ROWS));
        if (!text) continue;
        stats.sheets = (stats.sheets ?? 0) + 1;
        signals.push({
          external_id: `sheet:${item.id}:${ws.id}`,
          title: `${item.name ?? item.id} · ${ws.name ?? ws.id}`,
          text: clip(`${header} · Sheet: ${ws.name ?? ws.id}${range.data?.address ? ` (${range.data.address})` : ""}\n\n${text}`, 8000),
          url: item.webUrl,
          author: editor,
          at: item.lastModifiedDateTime,
          kind_hint: "sheet",
        });
        if (signals.length >= limit) break;
      }
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats };
  },
};
