/**
 * Datasets, server side: the guarded paths shared by the MCP `data`/`data_write`
 * tools and `/api/nodes/:id/dataset*`.
 *
 * The model, in one paragraph, because it is the whole point of this module.
 * A `data` node used to carry its table inside `content_md` as a ```csv block.
 * That cost three things: the block was chunked and embedded, so three
 * thousand customers were hundreds of chunks competing with the workspace's
 * actual knowledge in every search; `nodes(op=get)` dumped the whole table into
 * the agent's context; and every edit rewrote the body and collided on
 * `if_updated_at`. Now the rows live in `dataset_rows`, the node keeps only
 * what IS knowledge — title, description, columns and their types, the row
 * count — in `data.dataset`, and that is also the only thing embedded.
 *
 * Rows are canonical and the file is optional. An agent almost never holds a
 * CSV: it holds rows, from a query or an analysis. So every write accepts
 * `rows` directly and `csv` is the convenience, not the interface.
 */
import { randomUUID } from "node:crypto";
import {
  DATASET_MAX_ROWS,
  DATASET_MAX_ROWS_PER_WRITE,
  inferColumnType,
  inferSchema,
  type ColumnType,
  type DatasetColumn,
  type DatasetNodeData,
  type DatasetQuery,
  type DatasetSchema,
} from "@bcontext-dev/contract/datasets";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import type { Storage, UpdateNodeOpts } from "@/lib/storage";
import { parseCsv, CsvError } from "./csv";
import { DatasetError } from "./errors";
import { compileDatasetQuery, shapeDatasetRows } from "./query";
import {
  insertRows,
  readRowStats,
  readSampleRows,
  replaceAllRows,
  runDatasetSql,
  type DatasetTarget,
} from "./rows";
import { coerceRow, isBlank, widenColumnType, type CellValue } from "./values";

export { DatasetError, datasetErrorStatus } from "./errors";
export type { CellValue } from "./values";

/** Rows returned by `op=sample` when the caller does not say. */
export const DATASET_SAMPLE_DEFAULT = 5;
export const DATASET_SAMPLE_MAX = 50;

/* -- node.data plumbing ----------------------------------------------------- */

function readDatasetData(
  data: Record<string, unknown> | null | undefined,
): DatasetNodeData {
  return (data && typeof data === "object" ? data : {}) as DatasetNodeData;
}

function withDataset(
  data: Record<string, unknown> | null | undefined,
  dataset: DatasetSchema,
): Record<string, unknown> {
  const base = data && typeof data === "object" ? { ...(data as Record<string, unknown>) } : {};
  base.dataset = dataset;
  return base;
}

/** `data` without the schema — for payloads that return it separately. */
export function withoutDataset(
  data: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const { dataset: _dataset, ...rest } = data as Record<string, unknown>;
  return rest;
}

function assertDatasetKind(node: Pick<KnowledgeNode, "kind">): void {
  if (node.kind !== "data") {
    throw new DatasetError(
      "wrong_kind",
      `this node is a ${node.kind}, not a dataset. data_write only edits \`data\` nodes; use nodes_write for the rest.`,
    );
  }
}

async function loadDataset(
  storage: Storage,
  nodeId: string,
): Promise<{ node: KnowledgeNode; data: DatasetNodeData; dataset: DatasetSchema; target: DatasetTarget }> {
  const node = await storage.getNode(nodeId);
  if (!node) throw new DatasetError("not_found", `node not found: ${nodeId}`);
  assertDatasetKind(node);
  const data = readDatasetData(node.data);
  if (!data.dataset) {
    throw new DatasetError(
      "no_dataset",
      `\`${node.title}\` has no dataset yet. Write its rows with data_write(op=replace_rows) first.`,
    );
  }
  return {
    node,
    data,
    dataset: data.dataset,
    target: { nodeId: node.id, workspaceId: storage.workspace.id },
  };
}

/* -- schema building -------------------------------------------------------- */

export interface RowsInput {
  /** A CSV file, header included. */
  csv?: string | null;
  /** Rows as objects — what an agent actually has. */
  rows?: Record<string, unknown>[] | null;
  /** Override inferred types for named columns (inference is conservative, not clairvoyant). */
  columns?: Array<{ name: string; type: ColumnType }> | null;
}

interface NormalizedRows {
  header: string[];
  /** Cells in header order, as written. */
  cells: unknown[][];
}

/**
 * `csv` or `rows` reduced to one rectangular table. Exactly one of the two:
 * accepting both would mean deciding an order nobody asked for.
 */
function normalizeRowsInput(input: RowsInput, opts: { maxRows: number }): NormalizedRows {
  const hasCsv = typeof input.csv === "string" && input.csv.trim() !== "";
  const hasRows = Array.isArray(input.rows);
  if (hasCsv && hasRows) {
    throw new DatasetError("invalid_query", "pass `csv` or `rows`, not both");
  }
  if (hasCsv) {
    let table;
    try {
      table = parseCsv(input.csv as string, { maxRows: opts.maxRows + 1 });
    } catch (err) {
      throw new DatasetError("invalid_csv", err instanceof CsvError ? err.message : String(err));
    }
    assertBatchSize(table.rows.length, opts.maxRows);
    return { header: table.header, cells: table.rows };
  }
  if (!hasRows) {
    throw new DatasetError("invalid_query", "no data: pass `rows` (objects) or `csv`");
  }
  const rows = input.rows as Record<string, unknown>[];
  assertBatchSize(rows.length, opts.maxRows);
  // Column order is first-appearance order across the batch: a row that adds a
  // column late still contributes it, and nothing is silently dropped because
  // the first row happened not to mention it.
  const header: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new DatasetError("invalid_query", "every entry of `rows` must be an object of column → value");
    }
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        header.push(key);
      }
    }
  }
  return { header, cells: rows.map((row) => header.map((name) => row[name])) };
}

function assertBatchSize(count: number, maxRows: number): void {
  if (count > maxRows) {
    throw new DatasetError(
      "too_many_rows",
      `${count} rows in one write; at most ${maxRows}. Send them in batches with op=append_rows.`,
    );
  }
}

/** Types from the data, then the caller's overrides on top. */
function buildColumns(
  normalized: NormalizedRows,
  overrides: RowsInput["columns"],
): DatasetColumn[] {
  const columns = inferSchema(normalized.header, normalized.cells);
  for (const override of overrides ?? []) {
    const column = columns.find((c) => c.name === override.name);
    if (!column) {
      throw new DatasetError(
        "unknown_column",
        `\`columns\` names \`${override.name}\`, which is not in the data. Columns: ${normalized.header.join(", ")}`,
      );
    }
    column.type = override.type;
  }
  if (columns.length === 0) throw new DatasetError("invalid_query", "a dataset needs at least one column");
  return columns;
}

function typedRows(columns: readonly DatasetColumn[], normalized: NormalizedRows): Record<string, CellValue>[] {
  return normalized.cells.map((cells) => {
    const raw: Record<string, unknown> = {};
    normalized.header.forEach((name, index) => {
      raw[name] = cells[index];
    });
    return coerceRow(columns, raw);
  });
}

function schemaOf(
  columns: DatasetColumn[],
  rowCount: number,
  sourceFile: DatasetSchema["source_file"] = null,
): DatasetSchema {
  return {
    schema_version: 1,
    columns,
    row_count: rowCount,
    source_file: sourceFile ?? null,
    updated_at: new Date().toISOString(),
  };
}

/* -- reads ------------------------------------------------------------------ */

export interface DatasetDescription {
  node_id: string;
  title: string;
  updated_at: string;
  description: string | null;
  columns: DatasetColumn[];
  row_count: number;
  source_file: DatasetSchema["source_file"];
}

/** What a `data` node IS: its shape, never its rows. */
export function describeDatasetNode(node: KnowledgeNode): DatasetDescription | null {
  const data = readDatasetData(node.data);
  if (!data.dataset) return null;
  return {
    node_id: node.id,
    title: node.title,
    updated_at: node.updated_at,
    description: data.description ?? null,
    columns: data.dataset.columns,
    row_count: data.dataset.row_count,
    source_file: data.dataset.source_file ?? null,
  };
}

export async function readDatasetSchema(storage: Storage, nodeId: string): Promise<DatasetDescription> {
  const { node } = await loadDataset(storage, nodeId);
  return describeDatasetNode(node)!;
}

/**
 * N rows, in file order.
 *
 * Worth more than it looks: knowing a dataset has a `plan` column is not the
 * same as knowing its values are `free|pro|enterprise`, and five rows is the
 * difference. Every question an agent asks afterwards is shaped by it, so this
 * is the last place to save bytes.
 */
export async function sampleDataset(
  storage: Storage,
  nodeId: string,
  limit = DATASET_SAMPLE_DEFAULT,
): Promise<{ description: DatasetDescription; rows: Record<string, unknown>[] }> {
  const { node, target } = await loadDataset(storage, nodeId);
  const capped = Math.min(Math.max(1, Math.trunc(limit)), DATASET_SAMPLE_MAX);
  return { description: describeDatasetNode(node)!, rows: await readSampleRows(target, capped) };
}

export interface DatasetQueryResult {
  rows: Record<string, unknown>[];
  row_count: number;
  limit: number;
  offset: number;
  /** True when more rows matched than the limit returned. */
  truncated: boolean;
}

export async function queryDataset(
  storage: Storage,
  nodeId: string,
  query: DatasetQuery,
): Promise<DatasetQueryResult> {
  const { dataset, target } = await loadDataset(storage, nodeId);
  const compiled = compileDatasetQuery(query, dataset.columns, target);
  const rows = shapeDatasetRows(compiled.shape, await runDatasetSql(compiled.text, compiled.values));
  return {
    rows,
    row_count: dataset.row_count,
    limit: compiled.limit,
    offset: compiled.offset,
    // A page that came back full may have left rows behind; saying so is what
    // stops an agent treating 100 rows as the whole answer.
    truncated: rows.length === compiled.limit,
  };
}

/* -- writes ----------------------------------------------------------------- */

export interface DatasetWriteResult {
  node: KnowledgeNode;
  before: KnowledgeNode;
  dataset: DatasetSchema;
  /** Rows this write added or replaced. */
  rows_written: number;
  summary: string;
}

export interface CreateDatasetInput extends RowsInput {
  title: string;
  /** The only prose that reaches the vector index — what makes the dataset findable. */
  description?: string | null;
  content_md?: string | null;
  parent_id?: string | null;
  tag_ids?: string[];
  source_file?: DatasetSchema["source_file"];
}

export async function createDataset(
  storage: Storage,
  input: CreateDatasetInput,
): Promise<{ node: KnowledgeNode; dataset: DatasetSchema; rows_written: number }> {
  const normalized = normalizeRowsInput(input, { maxRows: DATASET_MAX_ROWS_PER_WRITE });
  const columns = buildColumns(normalized, input.columns);
  const rows = typedRows(columns, normalized);
  const created = await storage.createNode({
    title: input.title,
    kind: "data",
    parent_id: input.parent_id ?? null,
    content_md: input.content_md ?? "",
    data: {
      ...(input.description ? { description: input.description } : {}),
      dataset: schemaOf(columns, 0, input.source_file),
    },
    tag_ids: input.tag_ids,
  });
  const target: DatasetTarget = { nodeId: created.id, workspaceId: storage.workspace.id };
  await insertRows(target, 0, rows);
  const dataset = schemaOf(columns, rows.length, input.source_file);
  const node = await storage.updateNode(created.id, { data: withDataset(created.data, dataset) });
  return { node: node ?? created, dataset, rows_written: rows.length };
}

/**
 * Add rows to an existing dataset.
 *
 * Two rules make this safe to call repeatedly. A key the schema does not have
 * is refused rather than added: growing the shape of a dataset by appending is
 * how a column ends up half-populated with nobody able to say from when.
 * And a batch whose values contradict a column's type demotes that column to
 * `text`, the same conservatism `inferColumnType` applies — a column that is
 * numeric "except for the rows that say N/A" drops those rows out of every
 * range filter, which is worse than admitting it is text.
 */
export async function appendRowsToDataset(
  storage: Storage,
  nodeId: string,
  input: RowsInput,
  opts: UpdateNodeOpts = {},
): Promise<DatasetWriteResult> {
  const { node, dataset, target } = await loadDataset(storage, nodeId);
  const normalized = normalizeRowsInput(input, { maxRows: DATASET_MAX_ROWS_PER_WRITE });
  const known = new Set(dataset.columns.map((column) => column.name));
  const unknown = normalized.header.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new DatasetError(
      "unknown_column",
      `these rows carry column${unknown.length > 1 ? "s" : ""} the dataset does not have: ${unknown.join(", ")}. ` +
        `Columns: ${dataset.columns.map((c) => c.name).join(", ")}. Changing the shape is op=replace_rows.`,
    );
  }
  const columns = widenColumns(dataset.columns, normalized);
  const rows = typedRows(columns, normalized);
  const stats = await readRowStats(target);
  if (stats.count + rows.length > DATASET_MAX_ROWS) {
    throw new DatasetError(
      "too_many_rows",
      `this dataset holds ${stats.count} rows and a dataset holds at most ${DATASET_MAX_ROWS}; ` +
        `${rows.length} more would not fit.`,
    );
  }
  // Indexes continue from the highest one used, never from the count: `idx` is
  // stable and may have gaps, so counting would reuse an index that still
  // means a different row.
  await insertRows(target, stats.maxIdx + 1, rows);
  return finishWrite(storage, node, columns, dataset, `${rows.length} rows appended`, rows.length, opts);
}

/** Replace the rows AND the schema: a replace is a new table, not an edit. */
export async function replaceDatasetRows(
  storage: Storage,
  nodeId: string,
  input: RowsInput,
  opts: UpdateNodeOpts = {},
): Promise<DatasetWriteResult> {
  const node = await storage.getNode(nodeId);
  if (!node) throw new DatasetError("not_found", `node not found: ${nodeId}`);
  assertDatasetKind(node);
  const previous = readDatasetData(node.data).dataset ?? null;
  const normalized = normalizeRowsInput(input, { maxRows: DATASET_MAX_ROWS_PER_WRITE });
  const columns = buildColumns(normalized, input.columns);
  const rows = typedRows(columns, normalized);
  const target: DatasetTarget = { nodeId: node.id, workspaceId: storage.workspace.id };
  await replaceAllRows(target, rows);
  return finishWrite(
    storage,
    node,
    columns,
    previous ?? schemaOf(columns, 0),
    `${rows.length} rows replace the dataset`,
    rows.length,
    opts,
  );
}

function widenColumns(columns: readonly DatasetColumn[], normalized: NormalizedRows): DatasetColumn[] {
  return columns.map((column) => {
    const index = normalized.header.indexOf(column.name);
    if (index === -1) return { ...column, nullable: true };
    const values = normalized.cells.map((cells) => cells[index]);
    // A batch with nothing but blanks in this column carries no evidence about
    // its type; `inferColumnType` answers "text" for it, which would demote
    // every column an incomplete batch happens not to fill.
    const evidence = values.some((value) => !isBlank(value)) ? inferColumnType(values) : null;
    return {
      name: column.name,
      type: widenColumnType(column.type, evidence),
      nullable: column.nullable || values.some(isBlank) || values.length !== normalized.cells.length,
    };
  });
}

async function finishWrite(
  storage: Storage,
  before: KnowledgeNode,
  columns: DatasetColumn[],
  previous: DatasetSchema,
  summary: string,
  rowsWritten: number,
  opts: UpdateNodeOpts,
): Promise<DatasetWriteResult> {
  const target: DatasetTarget = { nodeId: before.id, workspaceId: storage.workspace.id };
  // The count is read back from the table rather than added up. Two writers
  // appending at once would otherwise both add their own batch to the count
  // they read, and the node would under-report forever; re-reading makes every
  // write self-healing instead.
  const stats = await readRowStats(target);
  const dataset = schemaOf(columns, stats.count, previous.source_file ?? null);
  const node = await storage.updateNode(before.id, { data: withDataset(before.data, dataset) }, opts);
  if (!node) throw new DatasetError("not_found", `node not found: ${before.id}`);
  return { node, before, dataset, rows_written: rowsWritten, summary };
}

/* -- the original file ------------------------------------------------------ */

const DATASET_BUCKET = "dataset-files";

/**
 * Store the CSV a dataset came from. Optional by construction: rows are the
 * dataset, and a dataset an agent built out of a query has no file at all.
 * Private bucket — this is the customer's data file, so it is reached through
 * a signed URL and never a permanent public link.
 */
async function storeSourceFile(
  storage: Storage,
  nodeId: string,
  file: { filename: string; content: string; contentType?: string },
): Promise<NonNullable<DatasetSchema["source_file"]>> {
  if (storage.backend !== "supabase") {
    throw new DatasetError(
      "unsupported_backend",
      "storing the original file needs a persisted (Supabase) workspace",
    );
  }
  const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
  const extension = file.filename.toLowerCase().endsWith(".tsv") ? "tsv" : "csv";
  const path = `${storage.workspace.id}/${nodeId}/${randomUUID()}.${extension}`;
  const bytes = Buffer.from(file.content, "utf8");
  const { error } = await getSupabaseAdmin()
    .storage.from(DATASET_BUCKET)
    .upload(path, bytes, { contentType: file.contentType ?? "text/csv", upsert: false });
  if (error) throw new DatasetError("invalid_csv", `could not store the source file: ${error.message}`);
  return { path, filename: file.filename, bytes: bytes.byteLength, uploaded_at: new Date().toISOString() };
}

/**
 * Store the file AND record it on the node, once the rows are already in.
 * Deliberately a second step: the dataset is its rows, so a bucket that
 * refuses the upload must not cost the caller the data it just wrote.
 */
export async function attachSourceFile(
  storage: Storage,
  nodeId: string,
  file: { filename: string; content: string; contentType?: string },
): Promise<DatasetSchema> {
  const { node, dataset } = await loadDataset(storage, nodeId);
  const source = await storeSourceFile(storage, nodeId, file);
  const next: DatasetSchema = { ...dataset, source_file: source, updated_at: new Date().toISOString() };
  await storage.updateNode(node.id, { data: withDataset(node.data, next) });
  return next;
}

/** A time-limited link to the original file, issued after the grant was checked. */
export async function signedSourceFileUrl(path: string, expiresIn = 300): Promise<string> {
  const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
  const { data, error } = await getSupabaseAdmin()
    .storage.from(DATASET_BUCKET)
    .createSignedUrl(path, expiresIn);
  if (error || !data) throw new DatasetError("not_found", `could not sign the source file: ${error?.message}`);
  const { toPublicSupabaseUrl } = await import("@/lib/env");
  return toPublicSupabaseUrl(data.signedUrl);
}
