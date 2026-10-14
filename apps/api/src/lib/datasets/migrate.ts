/**
 * Move the `data` nodes that already exist onto the new model.
 *
 * Until now a `data` node kept its table inside `content_md`, in a ```csv
 * fence. This lifts that block into `dataset_rows`, records the inferred
 * schema in `data.dataset`, and leaves the prose that surrounded it as the
 * node's body — which is what the body was always for.
 *
 * Idempotent, and re-runnable on a workspace that is half done: a node that
 * already has `data.dataset` is left alone, and so is a `data` node with no
 * CSV block at all — an empty dataset somebody created by hand is not a
 * failure to fix, it is a node waiting for its rows.
 *
 * It lives here rather than in SQL for the reason migration 0086 gives: doing
 * it in PL/pgSQL means a CSV parser in PL/pgSQL, and the first file with a
 * comma inside quotes leaves the dataset silently wrong.
 */
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import type { Storage } from "@/lib/storage";
import { DatasetError } from "./errors";
import { replaceDatasetRows } from "./index";

/** ```csv (or ```tsv) … ``` — the shape the web wrote and the grid read. */
const CSV_FENCE = /^[ \t]*```[ \t]*(?:csv|tsv)[ \t]*\r?\n([\s\S]*?)\r?\n?^[ \t]*```[ \t]*$/im;

export interface ExtractedCsv {
  csv: string;
  /** The body with the block removed: whatever prose was written around it. */
  remainder: string;
}

export function extractCsvBlock(contentMd: string | null | undefined): ExtractedCsv | null {
  if (!contentMd) return null;
  const match = CSV_FENCE.exec(contentMd);
  if (!match || match[1]!.trim() === "") return null;
  const remainder = contentMd.replace(CSV_FENCE, "").replace(/\n{3,}/g, "\n\n").trim();
  return { csv: match[1]!, remainder };
}

export type MigrationOutcome = "migrated" | "already_migrated" | "no_csv_block" | "failed";

export interface NodeMigrationResult {
  node_id: string;
  title: string;
  outcome: MigrationOutcome;
  rows?: number;
  columns?: number;
  error?: string;
}

export interface MigrationSummary {
  scanned: number;
  migrated: number;
  skipped: number;
  failed: number;
  results: NodeMigrationResult[];
}

export interface MigrateOptions {
  /** Report what would happen and write nothing. */
  dryRun?: boolean;
  /** Nodes to look at, when the caller already has them. */
  nodes?: KnowledgeNode[];
}

async function migrateDataNode(
  storage: Storage,
  node: KnowledgeNode,
  opts: { dryRun?: boolean } = {},
): Promise<NodeMigrationResult> {
  const base = { node_id: node.id, title: node.title };
  const data = (node.data ?? {}) as Record<string, unknown>;
  if (data.dataset) return { ...base, outcome: "already_migrated" };
  const extracted = extractCsvBlock(node.content_md);
  if (!extracted) return { ...base, outcome: "no_csv_block" };

  if (opts.dryRun) {
    const lines = extracted.csv.trim().split(/\r?\n/).length;
    return { ...base, outcome: "migrated", rows: Math.max(0, lines - 1) };
  }
  try {
    // `replace_rows` is exactly this operation: infer the schema, write the
    // rows, stamp the node. Reusing it means the migrated dataset is
    // indistinguishable from one written by an agent today.
    const result = await replaceDatasetRows(storage, node.id, { csv: extracted.csv });
    // The body is rewritten in the same pass, after the rows are safely in: a
    // failure between the two leaves the CSV in the body and `data.dataset`
    // unset, which the next run treats as un-migrated and redoes.
    await storage.updateNode(node.id, { content_md: extracted.remainder });
    return {
      ...base,
      outcome: "migrated",
      rows: result.dataset.row_count,
      columns: result.dataset.columns.length,
    };
  } catch (err) {
    return {
      ...base,
      outcome: "failed",
      error: err instanceof DatasetError ? `${err.code}: ${err.message}` : String(err),
    };
  }
}

export async function migrateDataNodes(
  storage: Storage,
  opts: MigrateOptions = {},
): Promise<MigrationSummary> {
  const nodes = opts.nodes ?? (await storage.listNodes({ limit: 5000 }));
  const datasets = nodes.filter((node) => node.kind === "data");
  const results: NodeMigrationResult[] = [];
  for (const node of datasets) {
    // One node at a time on purpose: a dataset is up to DATASET_MAX_ROWS rows,
    // and doing several at once would put the whole workspace's data in memory
    // for no gain — this runs once.
    results.push(await migrateDataNode(storage, node, opts));
  }
  return {
    scanned: datasets.length,
    migrated: results.filter((r) => r.outcome === "migrated").length,
    skipped: results.filter((r) => r.outcome === "already_migrated" || r.outcome === "no_csv_block").length,
    failed: results.filter((r) => r.outcome === "failed").length,
    results,
  };
}
