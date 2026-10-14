/**
 * RFC4180-ish CSV, parsed and serialized in the browser: quoted fields,
 * embedded commas, escaped quotes (`""`) and CRLF/LF newlines.
 *
 * The rows of a `data` node live on the server now, so this is no longer how a
 * dataset is stored — it is only how a CSV a person drops on one is read
 * before it is sent, and how the batches that carry it are written back out
 * (see `src/lib/datasets.ts`).
 */

export interface ParsedCsv {
  columns: string[];
  rows: Record<string, string>[];
}

/** Splits one CSV record's worth of characters into fields, handling quotes. */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Trailing field/row (files without a final newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Parses a CSV string (header + data rows) into columns + row objects. */
export function parseCsv(csv: string): ParsedCsv {
  const trimmed = csv.trim();
  if (trimmed.length === 0) return { columns: [], rows: [] };
  const grid = parseCsvRows(trimmed).filter((r) => !(r.length === 1 && r[0] === ""));
  if (grid.length === 0) return { columns: [], rows: [] };
  const columns = grid[0]!.map((c) => c.trim());
  const rows = grid.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    columns.forEach((col, idx) => {
      record[col] = cells[idx] ?? "";
    });
    return record;
  });
  return { columns, rows };
}

/** Quotes a single CSV field only when required (contains `,`, `"`, or a newline). */
function quoteField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Serializes columns + row objects back into a CSV string (no trailing newline). */
export function serializeCsv(columns: string[], rows: Record<string, string>[]): string {
  const lines = [columns.map(quoteField).join(",")];
  for (const row of rows) {
    lines.push(columns.map((col) => quoteField(row[col] ?? "")).join(","));
  }
  return lines.join("\n");
}
