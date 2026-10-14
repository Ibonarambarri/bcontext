/**
 * Supabase — `supabase` → Nango `supabase` (API_KEY: service role key; proxy
 * base https://<connection_config.projectUrl>, Nango sets the `apikey`
 * header).
 *
 * Table-driven: `config.tables` names what to read — `["decisions",
 * "customers"]` or `[{ name, updated_at_column, select }]`. Each run reads
 * rows whose `updated_at` (or the configured column) is after the cursor
 * through PostgREST, newest first, 100 per table, one signal per row with
 * the record flattened as `key: value` lines. A table without a timestamp
 * column can set `updated_at_column: null` to read its latest 100 rows
 * every run. No tables configured → zero signals + `missing_tables`.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { str, type NangoAdapter } from "./shared";
import { renderRecord } from "./tabular";

export interface SupabaseTableSpec {
  name: string;
  /** Column compared with the cursor; `null` = no time filter. */
  updatedAtColumn: string | null;
  select: string;
}

export const SUPABASE_PAGE = 100;

export function supabaseTables(config: Record<string, unknown>): SupabaseTableSpec[] {
  const raw = config.tables;
  if (!Array.isArray(raw)) return [];
  const out: SupabaseTableSpec[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      if (item.trim()) out.push({ name: item.trim(), updatedAtColumn: "updated_at", select: "*" });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const t = item as { name?: unknown; updated_at_column?: unknown; select?: unknown };
    const name = str(t.name).trim();
    if (!name) continue;
    const column = t.updated_at_column === null ? null : str(t.updated_at_column).trim() || "updated_at";
    out.push({ name, updatedAtColumn: column, select: str(t.select).trim() || "*" });
  }
  return out;
}

function rowId(row: Record<string, unknown>): string {
  for (const key of ["id", "uuid", "key", "slug"]) {
    const v = row[key];
    if (v != null && v !== "") return str(v);
  }
  return "";
}

function rowTitle(table: string, row: Record<string, unknown>, id: string): string {
  for (const key of ["title", "name", "summary", "subject", "label", "email"]) {
    const v = row[key];
    if (typeof v === "string" && v.trim()) return `${table} · ${v.trim().slice(0, 100)}`;
  }
  return `${table} · ${id || "row"}`;
}

export const supabaseAdapter: NangoAdapter = {
  id: "supabase",
  provider: "supabase",
  sourceHint: "supabase:tables",
  async fetchChanges({ client, connectionId, connectionConfig, config, since, limit }) {
    const tables = supabaseTables(config);
    if (!tables.length) return { signals: [], stats: { missing_tables: 1 } };
    const projectUrl = str(connectionConfig.projectUrl).replace(/\/+$/, "");
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = { tables: tables.length, rows: 0, failed: 0 };
    const now = new Date().toISOString();
    for (const table of tables) {
      if (signals.length >= limit) break;
      const query: Record<string, string | number> = {
        select: table.select,
        limit: Math.min(SUPABASE_PAGE, limit),
      };
      if (table.updatedAtColumn) {
        query[table.updatedAtColumn] = `gte.${since.toISOString()}`;
        query.order = `${table.updatedAtColumn}.desc`;
      }
      const res = await client.proxy<Array<Record<string, unknown>>>({
        method: "GET",
        providerConfigKey: "supabase",
        connectionId,
        path: `/rest/v1/${encodeURIComponent(table.name)}`,
        query,
        headers: { Prefer: "count=exact" },
      });
      if (!res.ok) {
        stats.failed = (stats.failed ?? 0) + 1;
        continue;
      }
      const rows = Array.isArray(res.data) ? res.data : [];
      stats.rows = (stats.rows ?? 0) + rows.length;
      rows.forEach((row, i) => {
        if (signals.length >= limit) return;
        const id = rowId(row) || `${i}`;
        const at = table.updatedAtColumn ? str(row[table.updatedAtColumn]) : "";
        signals.push({
          external_id: `row:${table.name}:${id}`,
          title: rowTitle(table.name, row, id),
          text: [`Table: ${table.name}${at ? ` · Updated: ${at}` : ""}`, "", renderRecord(row)].join("\n"),
          url: projectUrl ? `${projectUrl}/rest/v1/${encodeURIComponent(table.name)}?${rowId(row) ? `id=eq.${encodeURIComponent(rowId(row))}` : ""}` : undefined,
          at: at || now,
          kind_hint: "row",
        });
      });
    }
    return { signals: signals.slice(0, limit), stats };
  },
};
