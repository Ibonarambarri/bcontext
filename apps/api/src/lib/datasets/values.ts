/**
 * Cells, on the way in and on the way into a filter.
 *
 * The one rule this module exists to enforce: a value is stored in `data`
 * jsonb ALREADY TYPED, per the column type `inferSchema` decided. A `number`
 * column holds `1200`, not `"1200"`. It reads like a detail and is not one —
 * as strings, `mrr > 500` compares alphabetically and `"90" > "500"` is true,
 * which is the exact bug the typed schema exists to prevent, and `data @>
 * {"mrr": 1200}` (the indexed path for equality) stops matching altogether.
 *
 * Postgres cannot check this: `dataset_rows` is one shared table with one
 * `jsonb` column, so the only constraint it can carry is that a row is an
 * object (see 0086). The guarantee is here.
 */
import type { ColumnType, DatasetColumn } from "@bcontext-dev/contract/datasets";
import { DatasetError } from "./errors";

/** A stored cell. `null` is "no value", whatever the column type. */
export type CellValue = string | number | boolean | null;

/** Same predicate the contract's inference uses, so types and nulls agree. */
export function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

const BOOLEAN_TRUE = new Set(["true", "yes", "1"]);
const BOOLEAN_FALSE = new Set(["false", "no", "0"]);

/**
 * ISO-8601, with the separator normalised to `T`.
 *
 * Not cosmetic: dates are compared and ordered as text (see `query.ts` for
 * why), and ` ` sorts before `T`, so `2026-01-01 10:00` would order before
 * `2026-01-01T09:00`. One separator, one order.
 */
function normalizeDate(raw: string): string {
  return raw.trim().replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T");
}

/**
 * One raw cell (a CSV string, or whatever JSON a caller sent) as the typed
 * JSON value that goes into `data`. A value that does not fit its column
 * comes back `null` rather than throwing: the column type was inferred from
 * the batch that created the dataset, and one later row saying `N/A` in a
 * numeric column must not fail the whole write — it is missing data, and
 * `nullable` already says the column has some.
 */
function coerceCell(type: ColumnType, raw: unknown): CellValue {
  if (isBlank(raw)) return null;
  switch (type) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      return Number.isFinite(n) ? n : null;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      const text = String(raw).trim().toLowerCase();
      if (BOOLEAN_TRUE.has(text)) return true;
      if (BOOLEAN_FALSE.has(text)) return false;
      return null;
    }
    case "date":
      return normalizeDate(String(raw));
    case "text":
      return typeof raw === "string" ? raw : String(raw);
  }
}

/** A whole row, keyed by column name, typed and with unknown keys already rejected. */
export function coerceRow(
  columns: readonly DatasetColumn[],
  raw: Record<string, unknown>,
): Record<string, CellValue> {
  const out: Record<string, CellValue> = {};
  for (const column of columns) out[column.name] = coerceCell(column.type, raw[column.name]);
  return out;
}

/**
 * A value a filter compares against. Unlike a cell, this one throws: a caller
 * writing `where mrr > "lots"` has made a mistake it can fix, and answering
 * with an empty result set would let it believe the dataset has no rows over
 * "lots" rather than that the question was malformed.
 */
export function coerceFilterValue(column: DatasetColumn, value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  switch (column.type) {
    case "number": {
      const n = typeof value === "number" ? value : Number(String(value).trim());
      if (!Number.isFinite(n)) {
        throw new DatasetError(
          "invalid_query",
          `\`${column.name}\` is a number column; ${JSON.stringify(value)} is not a number`,
        );
      }
      return n;
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      const text = String(value).trim().toLowerCase();
      if (BOOLEAN_TRUE.has(text)) return true;
      if (BOOLEAN_FALSE.has(text)) return false;
      throw new DatasetError(
        "invalid_query",
        `\`${column.name}\` is a boolean column; ${JSON.stringify(value)} is not true or false`,
      );
    }
    case "date": {
      const text = normalizeDate(String(value));
      if (!/^\d{4}-\d{2}-\d{2}/.test(text)) {
        throw new DatasetError(
          "invalid_query",
          `\`${column.name}\` is a date column; ${JSON.stringify(value)} is not an ISO date (YYYY-MM-DD…)`,
        );
      }
      return text;
    }
    case "text":
      return typeof value === "string" ? value : String(value);
  }
}

/**
 * The type a column keeps once `batch` is appended to it.
 *
 * Same conservatism as `inferColumnType`: evidence that contradicts the stored
 * type demotes the column to `text` rather than leaving values that no longer
 * fit. A column that is numeric "except for the 14 rows that say N/A" silently
 * drops those rows out of every range filter, which is worse than being text.
 * A batch with nothing but blanks in a column carries no evidence and changes
 * nothing.
 */
export function widenColumnType(current: ColumnType, batch: ColumnType | null): ColumnType {
  if (batch === null || batch === current) return current;
  return "text";
}
