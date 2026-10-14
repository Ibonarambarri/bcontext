/**
 * Datasets, browser side: the shape of the API's dataset payloads, the pure
 * helpers that turn interface state into a `DatasetQuery`, and the fetches
 * that carry them.
 *
 * The one rule this module exists to keep: **the browser never holds the
 * table**. A `data` node's rows live in their own table on the server and a
 * dataset may hold up to `DATASET_MAX_ROWS` of them, so every page, every
 * ordering and every filter is a question asked over the wire with `limit`,
 * `offset`, `order_by` and `where`. Sorting an array we already downloaded
 * would only move the problem into the tab.
 *
 * The types come from `@bcontext-dev/contract/datasets` — this file adds no
 * vocabulary of its own beyond the response envelopes the routes return.
 *
 * Every write is guarded like any other node write: it takes the
 * `updated_at` the caller last saw as `if_updated_at` and hands back the
 * server's node, so the caller can fold it in and chain the next write. A 409
 * surfaces as a `DatasetRequestError` with code `conflict` (`isConflict`).
 */
import {
  DATASET_MAX_ROWS,
  DATASET_MAX_ROWS_PER_WRITE,
  DATASET_QUERY_MAX_LIMIT,
  type ColumnType,
  type DatasetColumn,
  type DatasetFilter,
  type DatasetNodeData,
  type DatasetOperator,
  type DatasetQuery,
} from "@bcontext-dev/contract/datasets";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import { parseCsv, serializeCsv } from "@/lib/csv";
import { workspaceApiRef, type WorkspaceAddress } from "@/web/workspace-url";

export interface DatasetSourceFile {
  path: string;
  filename: string;
  bytes: number;
  uploaded_at: string;
}

/**
 * What the interface needs to draw a dataset: its shape, never its rows.
 * Deliberately narrower than the route's payload — `node_id` and `title` are
 * things the caller already has.
 */
export interface DatasetView {
  columns: DatasetColumn[];
  rowCount: number;
  /** The only prose a dataset contributes to search, so it is editable here. */
  description: string | null;
  sourceFile: DatasetSourceFile | null;
}

export interface DatasetRowsPage {
  rows: Record<string, unknown>[];
  /** Rows in the whole dataset — NOT how many matched a filter. */
  totalRows: number;
  limit: number;
  offset: number;
  /** The page came back full, so more rows may match. */
  truncated: boolean;
}

/** A failure the API named, so the interface can repeat its words. */
export class DatasetRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DatasetRequestError";
  }
}

/** `no_dataset` is not a failure: it is a `data` node that has no table yet. */
export function isMissingDataset(err: unknown): boolean {
  return err instanceof DatasetRequestError && (err.code === "no_dataset" || err.code === "not_found");
}

/** Someone else wrote the node first: re-read before writing again. */
export function isConflict(err: unknown): boolean {
  return err instanceof DatasetRequestError && err.code === "conflict";
}

/* -- reading the shape ------------------------------------------------------ */

function toSourceFile(value: unknown): DatasetSourceFile | null {
  if (!value || typeof value !== "object") return null;
  const file = value as Partial<DatasetSourceFile>;
  if (typeof file.path !== "string" || typeof file.filename !== "string") return null;
  return {
    path: file.path,
    filename: file.filename,
    bytes: typeof file.bytes === "number" ? file.bytes : 0,
    uploaded_at: typeof file.uploaded_at === "string" ? file.uploaded_at : "",
  };
}

/**
 * The dataset a node already carries in `data`, when it has one.
 *
 * The server-rendered node payload holds everything `GET …/dataset` returns,
 * so seeding from it paints the table without a round-trip. `null` means the
 * node has no dataset — which is exactly the state legacy `data` nodes are in.
 */
export function datasetFromNodeData(data: unknown): DatasetView | null {
  if (!data || typeof data !== "object") return null;
  const node = data as DatasetNodeData;
  const dataset = node.dataset;
  if (!dataset || !Array.isArray(dataset.columns) || dataset.columns.length === 0) return null;
  return {
    columns: dataset.columns,
    rowCount: typeof dataset.row_count === "number" ? dataset.row_count : 0,
    description: typeof node.description === "string" ? node.description : null,
    sourceFile: toSourceFile(dataset.source_file),
  };
}

/** The same view, from the route's payload. */
export function datasetFromResponse(payload: unknown): DatasetView | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as {
    columns?: unknown;
    row_count?: unknown;
    description?: unknown;
    source_file?: unknown;
  };
  if (!Array.isArray(body.columns) || body.columns.length === 0) return null;
  return {
    columns: body.columns as DatasetColumn[],
    rowCount: typeof body.row_count === "number" ? body.row_count : 0,
    description: typeof body.description === "string" ? body.description : null,
    sourceFile: toSourceFile(body.source_file),
  };
}

/* -- the query -------------------------------------------------------------- */

/**
 * Which operators a column admits.
 *
 * Not decoration: the server refuses `contains` on a number and a range on a
 * boolean, so offering them would be offering an error. Ordered by how often
 * the question gets asked, not by the contract's declaration order.
 */
export function operatorsFor(type: ColumnType): DatasetOperator[] {
  if (type === "number") return ["eq", "ne", "gt", "gte", "lt", "lte", "is_null"];
  if (type === "boolean") return ["eq", "ne", "is_null"];
  if (type === "date") return ["eq", "ne", "gte", "lte", "starts_with", "is_null"];
  return ["contains", "eq", "ne", "starts_with", "is_null"];
}

export const OPERATOR_LABELS: Record<DatasetOperator, string> = {
  eq: "is",
  ne: "is not",
  lt: "is before/less than",
  lte: "is at most",
  gt: "is after/greater than",
  gte: "is at least",
  contains: "contains",
  starts_with: "starts with",
  in: "is one of",
  is_null: "is empty",
};

/** `is_null` asks about absence, so it is the one operator with no value. */
export function operatorTakesValue(op: DatasetOperator): boolean {
  return op !== "is_null";
}

export interface DatasetQueryState {
  limit: number;
  offset: number;
  sort: { column: string; direction: "asc" | "desc" } | null;
  filter: { column: string; op: DatasetOperator; value: string } | null;
}

/**
 * Interface state → the question the server answers.
 *
 * A filter whose value is still empty is dropped rather than sent: an
 * in-progress `contains ""` matches everything, and re-asking the whole
 * dataset on every keystroke of an unfinished filter is a page of rows nobody
 * asked for.
 */
export function buildDatasetQuery(state: DatasetQueryState): DatasetQuery {
  const query: DatasetQuery = {
    schema_version: 1,
    limit: Math.min(Math.max(1, Math.trunc(state.limit)), DATASET_QUERY_MAX_LIMIT),
    offset: Math.max(0, Math.trunc(state.offset)),
  };
  if (state.sort) query.order_by = { column: state.sort.column, direction: state.sort.direction };
  const where = filterClause(state.filter);
  if (where) query.where = [where];
  return query;
}

export function filterClause(
  filter: DatasetQueryState["filter"],
): DatasetFilter | null {
  if (!filter) return null;
  if (!operatorTakesValue(filter.op)) return { column: filter.column, op: filter.op };
  if (filter.value.trim() === "") return null;
  // Values travel as the text that was typed; the server coerces them against
  // the stored column type and says so plainly when they do not fit.
  return { column: filter.column, op: filter.op, value: filter.value };
}

/** Whether a filter is actually narrowing anything — the total row count only means the whole dataset. */
export function filterIsActive(filter: DatasetQueryState["filter"]): boolean {
  return filterClause(filter) !== null;
}

/* -- cells ------------------------------------------------------------------ */

/**
 * What one cell reads as.
 *
 * An absent value renders as an em dash and NEVER as `0` or `false`: a missing
 * measurement and a measurement of zero are different facts, and a table that
 * spells them the same way is lying about the data it holds.
 */
export function cellText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  return JSON.stringify(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/* -- legacy bodies ---------------------------------------------------------- */

/**
 * The ```csv fence a `data` node used to keep its table in.
 *
 * Same expression the server's migration uses, on purpose: a node converted
 * from the web has to end up byte-identical to one the migration converted,
 * or "already migrated" stops meaning anything.
 */
const CSV_FENCE = /^[ \t]*```[ \t]*(?:csv|tsv)[ \t]*\r?\n([\s\S]*?)\r?\n?^[ \t]*```[ \t]*$/im;

export interface LegacyCsv {
  csv: string;
  /** The body without the block: whatever prose was written around it. */
  remainder: string;
}

export function extractLegacyCsv(contentMd: string | null | undefined): LegacyCsv | null {
  if (!contentMd) return null;
  const match = CSV_FENCE.exec(contentMd);
  if (!match || match[1]!.trim() === "") return null;
  const remainder = contentMd.replace(CSV_FENCE, "").replace(/\n{3,}/g, "\n\n").trim();
  return { csv: match[1]!, remainder };
}

/* -- requests --------------------------------------------------------------- */

async function datasetJson(response: Response): Promise<unknown> {
  if (response.ok) return response.json();
  // A 409 is a conflict whatever the body calls it: callers branch on it.
  let code = response.status === 409 ? "conflict" : `http_${response.status}`;
  let message = `The API answered ${response.status}.`;
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    if (typeof body.error === "string" && response.status !== 409) code = body.error;
    if (typeof body.message === "string") message = body.message;
  } catch {
    /* a non-JSON failure keeps the generic words above */
  }
  throw new DatasetRequestError(code, message);
}

/** The dataset's shape. Throws `no_dataset` for a `data` node that has none. */
export async function fetchDatasetView(
  workspace: WorkspaceAddress,
  nodeId: string,
): Promise<DatasetView> {
  const url = `/api/nodes/${encodeURIComponent(nodeId)}/dataset?workspace=${encodeURIComponent(workspaceApiRef(workspace))}`;
  const payload = await datasetJson(await fetch(url));
  const view = datasetFromResponse(payload);
  if (!view) throw new DatasetRequestError("no_dataset", "This node has no dataset yet.");
  return view;
}

/** A time-limited link to the CSV the dataset was built from, when there is one. */
export async function fetchSourceFileUrl(
  workspace: WorkspaceAddress,
  nodeId: string,
): Promise<string | null> {
  const url = `/api/nodes/${encodeURIComponent(nodeId)}/dataset?workspace=${encodeURIComponent(workspaceApiRef(workspace))}&signed_url=1`;
  const payload = (await datasetJson(await fetch(url))) as { source_file_url?: unknown };
  return typeof payload.source_file_url === "string" ? payload.source_file_url : null;
}

/**
 * One page of rows. POST rather than GET because the question is a document:
 * a filter tree in a query string is encoding, length limits and a URL nobody
 * can read in a log.
 */
export async function fetchDatasetRows(
  workspace: WorkspaceAddress,
  nodeId: string,
  query: DatasetQuery,
): Promise<DatasetRowsPage> {
  const response = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}/dataset/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: workspaceApiRef(workspace), query }),
  });
  const payload = (await datasetJson(response)) as {
    rows?: unknown;
    row_count?: unknown;
    limit?: unknown;
    offset?: unknown;
    truncated?: unknown;
  };
  return {
    rows: Array.isArray(payload.rows) ? (payload.rows as Record<string, unknown>[]) : [],
    totalRows: typeof payload.row_count === "number" ? payload.row_count : 0,
    limit: typeof payload.limit === "number" ? payload.limit : query.limit ?? 0,
    offset: typeof payload.offset === "number" ? payload.offset : query.offset ?? 0,
    truncated: payload.truncated === true,
  };
}

async function writeRows(
  workspace: WorkspaceAddress,
  nodeId: string,
  op: "append_rows" | "replace_rows",
  csv: string,
  ifUpdatedAt: string | undefined,
): Promise<CsvIngestResult> {
  const response = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}/dataset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspace: workspaceApiRef(workspace),
      op,
      csv,
      ...(ifUpdatedAt ? { if_updated_at: ifUpdatedAt } : {}),
    }),
  });
  const payload = (await datasetJson(response)) as {
    node?: KnowledgeNode;
    rows_written?: unknown;
  };
  const data = payload.node?.data ?? {};
  return {
    rowsWritten: typeof payload.rows_written === "number" ? payload.rows_written : 0,
    dataset: datasetFromNodeData(data),
    data,
    node: payload.node ?? null,
  };
}

export interface CsvIngestResult {
  rowsWritten: number;
  dataset: DatasetView | null;
  data: Record<string, unknown>;
  /** The server's node after the last write, for the caller to fold in. */
  node: KnowledgeNode | null;
}

/**
 * Put a CSV in a `data` node, replacing whatever table was there.
 *
 * `replace_rows` is the right op even when the node has no dataset yet: a
 * replace IS the schema, so the same call both creates the table and swaps it.
 *
 * One write carries at most `DATASET_MAX_ROWS_PER_WRITE` rows, so a bigger
 * file goes in batches — the first replacing the table, the rest appending to
 * it. Without that, every export over five thousand lines would come back as
 * `too_many_rows` and the person holding the file would have no way through.
 *
 * Only the first batch is checked against `ifUpdatedAt`; each later batch is
 * guarded by the `updated_at` the previous one returned, so a peer's write
 * mid-upload stops the upload instead of being appended over.
 */
export async function ingestCsv(
  workspace: WorkspaceAddress,
  nodeId: string,
  csv: string,
  options: { ifUpdatedAt?: string; onProgress?: (written: number, total: number) => void } = {},
): Promise<CsvIngestResult> {
  const table = parseCsv(csv);
  if (table.columns.length === 0) {
    throw new DatasetRequestError("invalid_csv", "That file has no header row, so there are no columns to read.");
  }
  if (table.rows.length > DATASET_MAX_ROWS) {
    throw new DatasetRequestError(
      "too_many_rows",
      `That file holds ${formatCount(table.rows.length)} rows; a dataset holds at most ${formatCount(DATASET_MAX_ROWS)}.`,
    );
  }
  // A header with no rows is still a table: it defines the columns, and one
  // empty batch is how that gets said.
  const batches: Record<string, string>[][] = [];
  for (let at = 0; at < table.rows.length; at += DATASET_MAX_ROWS_PER_WRITE) {
    batches.push(table.rows.slice(at, at + DATASET_MAX_ROWS_PER_WRITE));
  }
  if (batches.length === 0) batches.push([]);

  let written = 0;
  let guard = options.ifUpdatedAt;
  let last: CsvIngestResult = { rowsWritten: 0, dataset: null, data: {}, node: null };
  for (let index = 0; index < batches.length; index += 1) {
    const body = serializeCsv(table.columns, batches[index]!);
    const result = await writeRows(workspace, nodeId, index === 0 ? "replace_rows" : "append_rows", body, guard);
    written += result.rowsWritten;
    guard = result.node?.updated_at ?? guard;
    last = { ...result, rowsWritten: written };
    options.onProgress?.(written, table.rows.length);
  }
  return last;
}

/**
 * Move a legacy `data` node onto the new model, the same way the server's
 * migration does: the rows first, then the body — so a failure between the two
 * leaves the CSV where it was and the node still convertible.
 */
export async function convertLegacyNode(
  workspace: WorkspaceAddress,
  nodeId: string,
  legacy: LegacyCsv,
  ifUpdatedAt?: string,
): Promise<CsvIngestResult> {
  const result = await ingestCsv(workspace, nodeId, legacy.csv, { ifUpdatedAt });
  const guard = result.node?.updated_at ?? ifUpdatedAt;
  const response = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspace: workspaceApiRef(workspace),
      ...(guard ? { if_updated_at: guard } : {}),
      content_md: legacy.remainder,
    }),
  });
  if (!response.ok) {
    throw new DatasetRequestError(
      "body_not_cleared",
      "The rows are in, but the CSV block is still in the body. Reload and convert again to clear it.",
    );
  }
  const body = (await response.json().catch(() => ({}))) as { node?: KnowledgeNode };
  return { ...result, node: body.node ?? result.node };
}

/** The description is the dataset's only prose in the vector index, so it saves like a field. */
export async function saveDescription(
  workspace: WorkspaceAddress,
  nodeId: string,
  data: Record<string, unknown>,
  description: string,
  ifUpdatedAt?: string,
): Promise<{ data: Record<string, unknown>; node: KnowledgeNode | null }> {
  const next = { ...data };
  if (description.trim()) next.description = description.trim();
  else delete next.description;
  const response = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspace: workspaceApiRef(workspace),
      ...(ifUpdatedAt ? { if_updated_at: ifUpdatedAt } : {}),
      data: next,
    }),
  });
  const body = (await datasetJson(response)) as { node?: KnowledgeNode };
  return { data: body.node?.data ?? next, node: body.node ?? null };
}
