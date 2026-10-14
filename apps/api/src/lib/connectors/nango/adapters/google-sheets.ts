/**
 * Google Sheets — `google-sheets` → Nango `google-sheet` (OAuth2 via google;
 * proxy base https://sheets.googleapis.com, Sheets API v4).
 *
 * The Sheets API cannot list spreadsheets or tell when one changed —
 * discovery and modification times live in Drive (the `google-drive`
 * connector already exports Sheets as text when a folder is watched). This
 * adapter is the "pinned spreadsheets" path: `config.spreadsheet_ids` names
 * the sheets NEXO should keep reading; every run re-reads each tab
 * (`A1:Z200`) and emits one signal per tab with a compact `|`-separated
 * table. Empty tabs are skipped. Without `spreadsheet_ids` it does nothing.
 *
 * `at` is the cursor instant because Sheets does not expose a modified
 * time; dedupe happens on the stable external_id (spreadsheet + gid).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, type NangoAdapter } from "./shared";

interface SheetMeta {
  properties?: { title?: string };
  sheets?: Array<{ properties?: { sheetId?: number; title?: string; gridProperties?: { rowCount?: number; columnCount?: number } } }>;
}

const RANGE = "A1:Z200";

/** Quote a tab title for an A1 range (single quotes doubled). */
export function sheetRange(tabTitle: string): string {
  return `'${tabTitle.replace(/'/g, "''")}'!${RANGE}`;
}

/** Rows → "a | b | c" lines; trailing empty cells trimmed, empty rows dropped. */
export function valuesToText(values: unknown[][] | undefined): string {
  const lines: string[] = [];
  for (const row of values ?? []) {
    const cells = row.map((c) => (c == null ? "" : String(c).replace(/\s+/g, " ").trim()));
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    if (!cells.length) continue;
    lines.push(cells.join(" | "));
  }
  return lines.join("\n");
}

export const googleSheetsAdapter: NangoAdapter = {
  id: "google-sheets",
  provider: "google-sheet",
  sourceHint: "google-sheets:tabs",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const ids = allowList(config, "spreadsheet_ids");
    if (!ids) return { signals: [], stats: { spreadsheets: 0, note_no_spreadsheet_ids: 1 } };
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = { spreadsheets: 0, tabs: 0, skipped: 0 };
    for (const id of ids.slice(0, 20)) {
      const meta = await client.proxy<SheetMeta>({
        method: "GET",
        providerConfigKey: "google-sheets",
        connectionId,
        path: `/v4/spreadsheets/${encodeURIComponent(id)}`,
        query: { includeGridData: false, fields: "properties.title,sheets.properties(sheetId,title,gridProperties)" },
      });
      if (!meta.ok) {
        stats.skipped = (stats.skipped ?? 0) + 1;
        continue;
      }
      stats.spreadsheets = (stats.spreadsheets ?? 0) + 1;
      const title = meta.data?.properties?.title ?? id;
      for (const sheet of meta.data?.sheets ?? []) {
        const tab = sheet.properties?.title;
        const gid = sheet.properties?.sheetId ?? 0;
        if (!tab) continue;
        const values = await client.proxy<{ values?: unknown[][] }>({
          method: "GET",
          providerConfigKey: "google-sheets",
          connectionId,
          path: `/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(sheetRange(tab))}`,
          query: { majorDimension: "ROWS", valueRenderOption: "FORMATTED_VALUE" },
        });
        if (!values.ok) {
          stats.skipped = (stats.skipped ?? 0) + 1;
          continue;
        }
        const text = valuesToText(values.data?.values);
        if (!text) continue;
        stats.tabs = (stats.tabs ?? 0) + 1;
        signals.push({
          external_id: `sheet:${id}:${gid}`,
          title: `${title} · ${tab}`,
          text: clip(text, 8000),
          url: `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${gid}`,
          at: since.toISOString(),
          kind_hint: "sheet",
        });
        if (signals.length >= limit) break;
      }
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats };
  },
};
