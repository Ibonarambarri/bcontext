/**
 * Smartsheet — `smartsheet` → Nango `smartsheet` (OAuth2; proxy base
 * https://api.${connectionConfig.domain}). `/2.0/sheets?modifiedSince`
 * finds the sheets touched after the cursor (or `config.sheet_ids`), then
 * `/2.0/sheets/{id}?rowsModifiedSince&include=discussions` returns only
 * the rows that changed plus the sheet's discussions. One signal per
 * sheet: changed rows as compact "Column: value" lines (≤ 40 rows) and
 * comments posted after the cursor.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, type NangoAdapter } from "./shared";

interface SmartsheetSheetSummary {
  id: number;
  name?: string;
  permalink?: string;
  modifiedAt?: string;
}

interface SmartsheetCell {
  columnId?: number;
  displayValue?: string;
  value?: unknown;
}

interface SmartsheetRow {
  id: number;
  rowNumber?: number;
  modifiedAt?: string;
  modifiedBy?: { name?: string; email?: string };
  cells?: SmartsheetCell[];
}

interface SmartsheetComment {
  id?: number;
  text?: string;
  createdAt?: string;
  createdBy?: { name?: string; email?: string };
}

interface SmartsheetDiscussion {
  id?: number;
  title?: string;
  comments?: SmartsheetComment[];
  lastCommentedAt?: string;
}

interface SmartsheetSheet {
  id: number;
  name?: string;
  permalink?: string;
  modifiedAt?: string;
  columns?: Array<{ id: number; title?: string }>;
  rows?: SmartsheetRow[];
  discussions?: SmartsheetDiscussion[];
}

const MAX_SHEETS = 20;
const MAX_ROWS = 40;

export const smartsheetAdapter: NangoAdapter = {
  id: "smartsheet",
  provider: "smartsheet",
  sourceHint: "smartsheet:sheets",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const wanted = allowList(config, "sheet_ids");
    let sheets: SmartsheetSheetSummary[];
    if (wanted) {
      sheets = wanted.map((id) => ({ id: Number(id) })).filter((s) => Number.isFinite(s.id));
    } else {
      const listed = await client.proxy<{ data?: SmartsheetSheetSummary[] }>({
        method: "GET",
        providerConfigKey: "smartsheet",
        connectionId,
        path: "/2.0/sheets",
        query: { modifiedSince: since.toISOString(), includeAll: true },
      });
      if (!listed.ok) throw new Error(`smartsheet sheets failed (${listed.status})`);
      sheets = listed.data?.data ?? [];
    }
    sheets = sheets.slice(0, MAX_SHEETS);

    const signals: IngestSignal[] = [];
    const stats = { sheets: sheets.length, rows: 0, comments: 0 };
    for (const summary of sheets) {
      const res = await client.proxy<SmartsheetSheet>({
        method: "GET",
        providerConfigKey: "smartsheet",
        connectionId,
        path: `/2.0/sheets/${summary.id}`,
        query: { rowsModifiedSince: since.toISOString(), include: "discussions", level: 2 },
      });
      if (!res.ok) throw new Error(`smartsheet sheet ${summary.id} failed (${res.status})`);
      const sheet = res.data ?? ({ id: summary.id } as SmartsheetSheet);
      const columns = new Map((sheet.columns ?? []).map((c) => [c.id, c.title ?? String(c.id)]));
      const rows = (sheet.rows ?? []).filter((r) => !r.modifiedAt || new Date(r.modifiedAt) > since);
      const comments = (sheet.discussions ?? []).flatMap((d) =>
        (d.comments ?? [])
          .filter((c) => !c.createdAt || new Date(c.createdAt) > since)
          .map((c) => ({ ...c, discussion: d.title })),
      );
      stats.rows += rows.length;
      stats.comments += comments.length;
      if (!rows.length && !comments.length) continue;

      const rowLines = rows.slice(0, MAX_ROWS).map((r) => {
        const cells = (r.cells ?? [])
          .map((c) => ({ k: (c.columnId != null && columns.get(c.columnId)) || "?", v: c.displayValue ?? (c.value == null ? "" : String(c.value)) }))
          .filter((x) => x.v)
          .map((x) => `${x.k}: ${x.v}`)
          .join(" · ");
        const who = r.modifiedBy?.name ?? r.modifiedBy?.email;
        return `- Row ${r.rowNumber ?? r.id}${who ? ` (${who})` : ""}: ${cells}`;
      });
      const commentLines = comments.map(
        (c) => `- ${c.createdBy?.name ?? c.createdBy?.email ?? "someone"} (${c.createdAt ?? ""})${c.discussion ? ` on "${c.discussion}"` : ""}: ${c.text ?? ""}`,
      );
      const latest = [...rows.map((r) => r.modifiedAt), ...comments.map((c) => c.createdAt), sheet.modifiedAt]
        .filter((x): x is string => !!x)
        .sort()
        .pop();
      signals.push({
        external_id: `sheet:${sheet.id}`,
        title: `${sheet.name ?? summary.name ?? `Sheet ${sheet.id}`} · ${rows.length} rows changed`,
        text: clip(
          [
            rowLines.length ? `Rows changed${rows.length > MAX_ROWS ? ` (first ${MAX_ROWS} of ${rows.length})` : ""}:\n${rowLines.join("\n")}` : null,
            commentLines.length ? `\nComments:\n${commentLines.join("\n")}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        ),
        url: sheet.permalink ?? summary.permalink,
        author: rows[0]?.modifiedBy?.name ?? comments[0]?.createdBy?.name,
        at: latest,
        kind_hint: "sheet",
      });
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats };
  },
};
