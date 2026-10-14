/**
 * One-shot CLI: re-embed every node in a workspace whose chunks are tagged
 * with an old `embedding_version` (anything ≠ the current `EMBEDDING_MODEL`).
 *
 * Usage:
 *
 *   tsx scripts/reembed-stale.ts <workspace_slug> [--limit N] [--dry-run]
 *
 * Requires `SUPABASE_SERVICE_ROLE_KEY` and `AI_GATEWAY_API_KEY` in the
 * environment, plus the Supabase URL under its `NEXT_PUBLIC_SUPABASE_URL`
 * spelling — the legacy alias of `SUPABASE_URL` that this script still reads
 * (aliases are honoured until 2026-12-31, src/lib/env.ts). Run it when
 * `EMBEDDING_MODEL` changes, one workspace at a time; it talks to Supabase
 * over HTTP (the instance's public URL, or `supabase status` locally), so
 * it needs no direct database access. Runs sequentially with a small inter-node delay
 * to avoid hammering the gateway.
 *
 * Anti-goals (intentional):
 *   - No partial / chunk-level migration: the embed pipeline already
 *     deletes-then-inserts a node's chunks atomically, so re-embedding a
 *     stale node is the cheapest path back to a single version.
 *   - No deletion of old chunks before the new ones are written; the new
 *     batch overwrites by node_id.
 */
import { createClient } from "@supabase/supabase-js";
import { embedNode } from "@/lib/rag/embed";
import {
  currentEmbeddingVersion,
  staleEmbeddingsQuery,
} from "@/lib/rag/embedding-version";

interface Args {
  workspace: string;
  limit: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const [workspace, ...rest] = argv;
  if (!workspace) {
    console.error("Usage: tsx scripts/reembed-stale.ts <workspace_slug> [--limit N] [--dry-run]");
    process.exit(1);
  }
  let limit = 100;
  let dryRun = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--limit") {
      const next = rest[i + 1];
      const n = next ? Number.parseInt(next, 10) : NaN;
      if (Number.isFinite(n) && n > 0) limit = n;
      i++;
    }
  }
  return { workspace, limit, dryRun };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const supa = createClient(url, key, { auth: { persistSession: false } });

  const { data: ws, error: wsErr } = await supa
    .from("workspaces")
    .select("id, slug")
    .eq("slug", args.workspace)
    .maybeSingle();
  if (wsErr || !ws) {
    console.error(`workspace not found: ${args.workspace} (${wsErr?.message ?? "no row"})`);
    process.exit(1);
  }

  const current = currentEmbeddingVersion();
  const q = staleEmbeddingsQuery(current);

  // Distinct stale node_ids in this workspace.
  const { data: stale, error: staleErr } = await supa
    .from("embeddings")
    .select("node_id, embedding_version")
    .eq("workspace_id", ws.id)
    .neq(q.column, q.notEqual)
    .limit(args.limit * 10); // over-fetch; we de-dup below
  if (staleErr) {
    console.error("stale query failed:", staleErr.message);
    process.exit(1);
  }

  const seen = new Set<string>();
  const nodeIds: string[] = [];
  for (const row of (stale ?? []) as Array<{ node_id: string }>) {
    if (!seen.has(row.node_id)) {
      seen.add(row.node_id);
      nodeIds.push(row.node_id);
      if (nodeIds.length >= args.limit) break;
    }
  }

  console.log(
    `[reembed-stale] workspace=${ws.slug} current=${current} stale_nodes=${nodeIds.length} dry_run=${args.dryRun}`,
  );

  if (args.dryRun || nodeIds.length === 0) {
    process.exit(0);
  }

  let ok = 0;
  let fail = 0;
  for (const nodeId of nodeIds) {
    try {
      const res = await embedNode(supa, nodeId);
      console.log(`  ${nodeId} → ${res.status} chunks=${res.chunks}`);
      ok++;
    } catch (err) {
      console.error(`  ${nodeId} → error:`, err instanceof Error ? err.message : err);
      fail++;
    }
    // small breather between calls
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log(`[reembed-stale] done ok=${ok} fail=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
