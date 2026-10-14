/**
 * Helpers for the query-driven adapters (Snowflake, BigQuery, Supabase,
 * Mixpanel, Amplitude): named SQL/table snippets from the install config and
 * a compact text rendering of tabular results that an LLM can read without
 * eating the whole batch.
 */
import { str } from "./shared";

export interface NamedQuery {
  name: string;
  sql: string;
}

/**
 * `config.queries` as `[{ name, sql }]` or `{ name: sql }`; blank entries
 * dropped. Empty means "the workspace has not told us what to read".
 */
export function namedQueries(config: Record<string, unknown>, key = "queries"): NamedQuery[] {
  const raw = config[key];
  const out: NamedQuery[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const q = item as { name?: unknown; sql?: unknown; query?: unknown };
      const sql = str(q.sql ?? q.query).trim();
      const name = str(q.name).trim() || sql.slice(0, 40);
      if (sql) out.push({ name, sql });
    }
  } else if (raw && typeof raw === "object") {
    for (const [name, sql] of Object.entries(raw as Record<string, unknown>)) {
      const text = str(sql).trim();
      if (name.trim() && text) out.push({ name: name.trim(), sql: text });
    }
  }
  return out;
}

/** `{{since}}` → ISO instant, so a snippet can say `where updated_at > '{{since}}'`. */
export function interpolateSince(sql: string, since: Date): string {
  return sql.replace(/\{\{\s*since\s*\}\}/g, since.toISOString());
}

/** A stable, url-safe id fragment for a query name. */
export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "query";
}

function cell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v).replace(/\s+/g, " ").trim();
}

/**
 * `col | col` header, `---`, then one `a | b` line per row, capped in rows
 * and characters. Truncation is stated in the text so NEXO knows.
 */
export function renderTable(headers: string[], rows: unknown[][], opts: { maxRows?: number; maxChars?: number } = {}): string {
  const maxRows = opts.maxRows ?? 200;
  const maxChars = opts.maxChars ?? 12_000;
  const lines: string[] = [];
  if (headers.length) {
    lines.push(headers.join(" | "));
    lines.push(headers.map(() => "---").join(" | "));
  }
  const shown = rows.slice(0, maxRows);
  for (const row of shown) lines.push(row.map(cell).join(" | "));
  if (rows.length > maxRows) lines.push(`… ${rows.length - maxRows} more rows`);
  let text = lines.join("\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n… (truncated)`;
  return text;
}

/** `key: value` lines for one record, skipping empties; long values clipped. */
export function renderRecord(record: Record<string, unknown>, maxValue = 400): string {
  return Object.entries(record)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => {
      const text = cell(v);
      return `${k}: ${text.length > maxValue ? `${text.slice(0, maxValue)}…` : text}`;
    })
    .join("\n");
}
