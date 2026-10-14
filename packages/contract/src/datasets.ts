// Dataset nodes — a `data` node's schema, and the query language both sides
// speak. Rows do NOT live here (or in `content_md`, or in `node.data`): they
// live in their own table, and everything in this file describes them from
// the outside.

/**
 * What a column holds. A CSV is all strings, so this is INFERRED at ingest
 * and stored — without it `mrr > 500` compares text ("90" > "500") and a
 * date sorts alphabetically. The inference is deliberately conservative:
 * one unparseable value in a column demotes the whole column to `text`,
 * because a column that is numeric "except for the 14 rows that say N/A"
 * silently drops those rows out of every range filter.
 */
export type ColumnType = "text" | "number" | "boolean" | "date";

export interface DatasetColumn {
  name: string;
  type: ColumnType;
  /** Values seen empty, so a caller can tell "no data" from "zero". */
  nullable: boolean;
}

/**
 * The part of a dataset that IS knowledge: what it holds and how it is
 * shaped. This is what gets embedded and what `nodes(op=get)` returns —
 * never the rows.
 */
export interface DatasetSchema {
  schema_version: 1;
  columns: DatasetColumn[];
  row_count: number;
  /** The original upload, when there was one. Agent-built datasets have none. */
  source_file?: {
    path: string;
    filename: string;
    bytes: number;
    uploaded_at: string;
  } | null;
  updated_at: string;
}

/** Conventions for `data` on a node of kind `data`. */
export interface DatasetNodeData {
  dataset?: DatasetSchema;
  /**
   * One line saying what this is. Not decoration: it is the only prose that
   * reaches the vector index, so it is what makes the dataset findable by
   * someone who does not know its name.
   */
  description?: string;
}

export const DATASET_OPERATORS = [
  "eq", "ne", "lt", "lte", "gt", "gte", "contains", "starts_with", "in", "is_null",
] as const;
export type DatasetOperator = (typeof DATASET_OPERATORS)[number];

export interface DatasetFilter {
  column: string;
  op: DatasetOperator;
  value?: string | number | boolean | null | Array<string | number>;
}

export const DATASET_AGGREGATES = ["count", "sum", "avg", "min", "max"] as const;
export type DatasetAggregate = (typeof DATASET_AGGREGATES)[number];

/**
 * The query language, versioned like `ViewQuery` and deliberately shaped
 * after it: this product already has one query contract, and a second
 * vocabulary for the same idea is how a codebase ends up with two ways to
 * say every sentence.
 *
 * It is a DSL and not SQL on purpose. An agent handing raw SQL to a shared
 * table is an injection surface, and no amount of escaping makes reviewing
 * that pleasant. This translates to parameterised SQL server-side, where the
 * column names are checked against the stored schema — so a filter can only
 * ever name a column that exists.
 */
export interface DatasetQuery {
  schema_version: 1;
  /** Columns to return; omitted means all of them. */
  select?: string[];
  where?: DatasetFilter[];
  order_by?: { column: string; direction: "asc" | "desc" };
  /** Group + aggregate. Without `group_by` the aggregate covers the whole match. */
  group_by?: string[];
  aggregate?: Array<{ fn: DatasetAggregate; column?: string; as: string }>;
  limit?: number;
  offset?: number;
}

/** Hard ceiling per query. A dataset is not a download endpoint. */
export const DATASET_QUERY_MAX_LIMIT = 1000;
export const DATASET_QUERY_DEFAULT_LIMIT = 100;

/**
 * Rows a single dataset may hold. This is the first table in the system
 * carrying user DATA rather than metadata, so the ceiling is set before
 * someone pastes a two-million-line export, not after.
 */
export const DATASET_MAX_ROWS = 200_000;
/** Rows one write may carry, so a batch stays a request and not an outage. */
export const DATASET_MAX_ROWS_PER_WRITE = 5_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const BOOLEANS = new Set(["true", "false", "yes", "no", "0", "1"]);

/** Empty-ish cells carry no type evidence either way. */
function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

/**
 * The narrowest type every non-blank value fits. Order matters: `boolean`
 * is tried before `number` because "0"/"1" parse as both, and a column of
 * flags is far more useful as booleans than as zeros and ones.
 */
export function inferColumnType(values: readonly unknown[]): ColumnType {
  let sawValue = false;
  let boolean = true;
  let number = true;
  let date = true;
  for (const value of values) {
    if (isBlank(value)) continue;
    sawValue = true;
    const text = String(value).trim();
    if (boolean && !BOOLEANS.has(text.toLowerCase())) boolean = false;
    if (number && !Number.isFinite(Number(text))) number = false;
    if (date && !ISO_DATE.test(text)) date = false;
    if (!boolean && !number && !date) return "text";
  }
  if (!sawValue) return "text";
  if (boolean) return "boolean";
  if (number) return "number";
  if (date) return "date";
  return "text";
}

/** Column descriptors for a table of raw cells, header included. */
export function inferSchema(header: readonly string[], rows: readonly (readonly unknown[])[]): DatasetColumn[] {
  return header.map((name, index) => {
    const column = rows.map((row) => row[index]);
    return {
      name,
      type: inferColumnType(column),
      nullable: column.some(isBlank),
    };
  });
}

/**
 * Reject a query that names a column the dataset does not have, BEFORE it
 * reaches SQL. Returns the offending names; empty means the query is safe
 * to translate.
 */
export function unknownColumns(query: DatasetQuery, columns: readonly DatasetColumn[]): string[] {
  const known = new Set(columns.map((column) => column.name));
  const named = [
    ...(query.select ?? []),
    ...(query.where ?? []).map((filter) => filter.column),
    ...(query.group_by ?? []),
    ...(query.aggregate ?? []).flatMap((agg) => (agg.column ? [agg.column] : [])),
    ...(query.order_by ? [query.order_by.column] : []),
  ];
  return [...new Set(named.filter((name) => !known.has(name)))];
}

/** The line a dataset contributes to the vector index — schema, never rows. */
export function datasetEmbeddingText(
  node: { title: string },
  data: DatasetNodeData,
): string {
  const columns = (data.dataset?.columns ?? []).map((c) => `${c.name} (${c.type})`).join(", ");
  return [
    node.title,
    data.description ?? "",
    columns ? `Columns: ${columns}` : "",
    data.dataset ? `${data.dataset.row_count} rows` : "",
  ].filter(Boolean).join("\n");
}
