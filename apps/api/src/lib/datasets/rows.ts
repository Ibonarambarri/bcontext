/**
 * The row table, and the only module that names it.
 *
 * Rows live in `public.dataset_rows` (migration 0086): `(node_id, idx)` is the
 * primary key, `workspace_id` is copied from the node and guarded by a
 * composite foreign key, and `data` is one jsonb object per row with its
 * values already typed.
 *
 * They are reached through `pg` rather than PostgREST because the query DSL
 * compiles to real SQL — typed comparisons, group-by, aggregates — and none of
 * that is expressible through the REST client. The pool is the one the job
 * runtime already owns (`@/lib/queue/db`), so this adds no second connection
 * story; `DATABASE_URL` is set on `bcontext-api` in production for the
 * realtime LISTEN, and datasets now depend on it too.
 */
import { DATASET_MAX_ROWS } from "@bcontext-dev/contract/datasets";
import { getPool, hasDatabaseUrl } from "@/lib/queue/db";
import { DatasetError } from "./errors";
import type { CellValue } from "./values";

export const DATASET_ROWS_TABLE = "public.dataset_rows";

/** The address of one dataset. Every statement below carries both halves. */
export interface DatasetTarget {
  nodeId: string;
  workspaceId: string;
}

export function datasetRowsAvailable(): boolean {
  return hasDatabaseUrl();
}

function requirePool() {
  if (!datasetRowsAvailable()) {
    throw new DatasetError(
      "unsupported_backend",
      "datasets need a direct database connection (DATABASE_URL); this process has none",
    );
  }
  return getPool();
}

export async function runDatasetSql<T extends Record<string, unknown>>(
  text: string,
  values: readonly unknown[],
): Promise<T[]> {
  const result = await requirePool().query(text, values as unknown[]);
  return result.rows as T[];
}

/** Rows in one dataset, and the highest index used. */
export async function readRowStats(target: DatasetTarget): Promise<{ count: number; maxIdx: number }> {
  const rows = await runDatasetSql<{ count: string | number; max_idx: number | null }>(
    `select count(*)::int as count, max(idx) as max_idx from ${DATASET_ROWS_TABLE}` +
      ` where node_id = $1::uuid and workspace_id = $2::uuid`,
    [target.nodeId, target.workspaceId],
  );
  const row = rows[0];
  return { count: Number(row?.count ?? 0), maxIdx: row?.max_idx ?? -1 };
}

/**
 * Append rows starting at `startIdx`.
 *
 * The whole batch travels as ONE jsonb parameter rather than four placeholders
 * per row: 5.000 rows would otherwise be 20.000 bind parameters and a
 * statement nobody can read in a log.
 */
export async function insertRows(
  target: DatasetTarget,
  startIdx: number,
  rows: readonly Record<string, CellValue>[],
  exec: (text: string, values: unknown[]) => Promise<unknown> = (text, values) =>
    runDatasetSql(text, values),
): Promise<void> {
  if (rows.length === 0) return;
  const last = startIdx + rows.length - 1;
  if (last >= DATASET_MAX_ROWS) {
    // The CHECK on `idx` in 0086 is the net underneath; its message is a
    // constraint name. This is the one a caller can act on.
    throw new DatasetError(
      "too_many_rows",
      `this write would reach row index ${last}; a dataset holds at most ${DATASET_MAX_ROWS} rows. ` +
        `Use op=replace_rows with the data you want, or split the dataset.`,
    );
  }
  const batch = rows.map((data, offset) => ({ idx: startIdx + offset, data }));
  await exec(
    `insert into ${DATASET_ROWS_TABLE} (node_id, workspace_id, idx, data)` +
      ` select $1::uuid, $2::uuid, t.idx, t.data` +
      ` from jsonb_to_recordset($3::jsonb) as t(idx int, data jsonb)`,
    [target.nodeId, target.workspaceId, JSON.stringify(batch)],
  );
}

async function deleteAllRows(
  target: DatasetTarget,
  exec: (text: string, values: unknown[]) => Promise<unknown> = (text, values) =>
    runDatasetSql(text, values),
): Promise<void> {
  await exec(
    `delete from ${DATASET_ROWS_TABLE} where node_id = $1::uuid and workspace_id = $2::uuid`,
    [target.nodeId, target.workspaceId],
  );
}

/**
 * Replace every row in one statement pair, inside a transaction: a replace
 * that deleted and then failed to insert would leave an empty dataset whose
 * node still claims a row count, and nothing would say which half happened.
 * Indexes restart at 0 — a replace is a new table, not an edit of the old one.
 */
export async function replaceAllRows(
  target: DatasetTarget,
  rows: readonly Record<string, CellValue>[],
): Promise<void> {
  requirePool();
  const { withTransaction } = await import("@/lib/queue/db");
  await withTransaction(async (tx) => {
    await deleteAllRows(target, (text, values) => tx.executeSql(text, values));
    await insertRows(target, 0, rows, (text, values) => tx.executeSql(text, values));
  });
}

/** The first `limit` rows in file order — what `op=sample` returns. */
export async function readSampleRows(
  target: DatasetTarget,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const rows = await runDatasetSql<{ data: Record<string, unknown> }>(
    `select data from ${DATASET_ROWS_TABLE} where node_id = $1::uuid and workspace_id = $2::uuid` +
      ` order by idx asc limit $3`,
    [target.nodeId, target.workspaceId, limit],
  );
  return rows.map((row) => row.data ?? {});
}
