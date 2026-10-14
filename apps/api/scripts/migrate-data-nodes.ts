/**
 * One-shot CLI: move a workspace's `data` nodes off the ```csv block in
 * `content_md` and into `dataset_rows`.
 *
 * Usage:
 *
 *   tsx scripts/migrate-data-nodes.ts <workspace_slug> [--dry-run]
 *
 * Needs `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (the nodes) and
 * `DATABASE_URL` (the rows). Idempotent: a node that already has
 * `data.dataset` is skipped, and so is a `data` node with no CSV block —
 * running it again after a partial failure finishes the job.
 *
 * The migration itself lives in `src/lib/datasets/migrate.ts` and is tested
 * there; this file is only the way to invoke it against one workspace. Run
 * once per workspace that predates `dataset_rows`; a workspace already on the
 * new shape is a no-op (`--dry-run` shows what would move).
 */
import { getStorage } from "@/lib/storage";
import { datasetRowsAvailable } from "@/lib/datasets/rows";
import { migrateDataNodes } from "@/lib/datasets/migrate";

async function main() {
  const [slug, ...rest] = process.argv.slice(2);
  if (!slug) {
    console.error("Usage: tsx scripts/migrate-data-nodes.ts <workspace_slug> [--dry-run]");
    process.exit(1);
  }
  const dryRun = rest.includes("--dry-run");
  if (!dryRun && !datasetRowsAvailable()) {
    console.error("DATABASE_URL is not set: the rows have nowhere to go.");
    process.exit(1);
  }
  const storage = await getStorage(slug);
  if (!storage) {
    console.error(`No such workspace: ${slug}`);
    process.exit(1);
  }

  const summary = await migrateDataNodes(storage, { dryRun });
  console.table(
    summary.results.map((result) => ({
      node: result.node_id.slice(0, 8),
      title: result.title.slice(0, 40),
      outcome: result.outcome,
      rows: result.rows ?? "",
      columns: result.columns ?? "",
      error: result.error ?? "",
    })),
  );
  console.log(
    `${summary.scanned} data nodes · ${summary.migrated} migrated · ` +
      `${summary.skipped} skipped · ${summary.failed} failed${dryRun ? " (dry run: nothing written)" : ""}`,
  );
  if (summary.failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
