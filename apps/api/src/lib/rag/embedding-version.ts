/**
 * Embedding versioning helpers.
 *
 * Every row in `embeddings` carries an `embedding_version` text tag — the
 * model id that produced it. We use that to:
 *
 *   1. Filter retrieval to chunks that match the *current* model only, so
 *      mixing dimensions/spaces from different models never happens.
 *   2. Detect "stale" rows after `EMBEDDING_MODEL` changes, so an operator
 *      can run `scripts/reembed-stale.ts` to migrate them.
 *
 * The helpers here are pure server-side utilities — they read env, build
 * the version string, and produce SQL-friendly filter values. No DB calls.
 */
import { resolveEmbeddingModel } from "@/lib/rag";

/**
 * Sentinel used for rows that pre-date the versioning column. The 0005
 * migration backfills existing rows with this value (column default).
 */
export const LEGACY_EMBEDDING_VERSION = "legacy";

/**
 * The version tag written by the embedding pipeline on insert. Today this
 * is just the model id resolved from env (`EMBEDDING_MODEL`). If we ever
 * need to invalidate without changing the model — e.g. a chunking-strategy
 * change — we can suffix `@vN` and increment.
 */
export function currentEmbeddingVersion(): string {
  return resolveEmbeddingModel();
}

/**
 * Whether a row's tag matches the current pipeline's version. Treats
 * undefined/empty as a mismatch so callers can default-fail-closed.
 */
export function isCurrentEmbeddingVersion(
  rowVersion: string | null | undefined,
  current: string = currentEmbeddingVersion(),
): boolean {
  if (!rowVersion) return false;
  return rowVersion === current;
}

/**
 * Build a stable Supabase-style filter object for `embeddings` queries
 * that should return only rows produced by the current model. Returned
 * shape mirrors `{ column: value }` so callers can `.eq(...)` it.
 *
 *   const { column, value } = currentVersionFilter();
 *   supa.from("embeddings").select("id").eq(column, value);
 */
export function currentVersionFilter(): {
  column: "embedding_version";
  value: string;
} {
  return { column: "embedding_version", value: currentEmbeddingVersion() };
}

export interface StaleQuery {
  /** Table the caller should query. */
  table: "embeddings";
  /** Column the caller should filter on. */
  column: "embedding_version";
  /** Operator — neq + null fallback handled in the helper below. */
  notEqual: string;
}

/**
 * Describe (declaratively) the rows considered "stale" given the current
 * model. The caller materializes the query against their own client so
 * this module stays free of supabase dependencies.
 *
 *   const q = staleEmbeddingsQuery();
 *   const { data } = await supa
 *     .from(q.table)
 *     .select("node_id", { count: "exact" })
 *     .neq(q.column, q.notEqual);
 */
export function staleEmbeddingsQuery(
  current: string = currentEmbeddingVersion(),
): StaleQuery {
  return {
    table: "embeddings",
    column: "embedding_version",
    notEqual: current,
  };
}

export interface MigrationStatus {
  /** Model id rows are migrating away from — null if every row already current. */
  migrating_from: string | null;
  /** Model id rows are migrating *to* (the current pipeline). */
  migrating_to: string;
  /** Total embedding rows in the workspace. */
  total: number;
  /** Rows already tagged with the current version. */
  done: number;
  /** Rows still tagged with an older version. */
  stale: number;
}

/**
 * Compute migration progress from a small set of (version, count) pairs.
 * Pure so it's trivial to unit-test; the API route is just glue.
 */
export function summarizeMigration(
  rows: Array<{ embedding_version: string | null; count: number }>,
  current: string = currentEmbeddingVersion(),
): MigrationStatus {
  let done = 0;
  let stale = 0;
  let staleSample: string | null = null;
  for (const r of rows) {
    const v = r.embedding_version ?? LEGACY_EMBEDDING_VERSION;
    const c = Number.isFinite(r.count) ? Math.max(0, Math.trunc(r.count)) : 0;
    if (v === current) {
      done += c;
    } else if (c > 0) {
      stale += c;
      // Prefer the most populated stale version when reporting `migrating_from`.
      if (staleSample === null) staleSample = v;
    }
  }
  return {
    migrating_from: stale > 0 ? staleSample : null,
    migrating_to: current,
    total: done + stale,
    done,
    stale,
  };
}
