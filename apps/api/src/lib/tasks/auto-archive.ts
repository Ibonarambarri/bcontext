/**
 * Auto-archive: a task or bug that has sat in `done` untouched for N days
 * (30 by default) moves to `archived` by itself.
 *
 * Archiving is cleanup, not deletion — the node stays readable by id, linked
 * and searchable; it just stops occupying the board and the graph. Doing it
 * on a schedule is what keeps a workspace's live views about live work
 * without anyone having to remember to tidy up: a task is created for a
 * piece of work, finished, and thirty quiet days later it is out of the way.
 *
 * Runs in the worker once a day (`tasks.auto-archive`). Idempotent — the
 * predicate is "done and untouched for N days", not "since the last run" —
 * and every flip is a normal status change: an activity entry (actor
 * `system`), a realtime broadcast, and the `updated_at` bump the trigger
 * gives any update. The update is guarded by the `updated_at` it read, so a
 * task someone edits between the read and the write is left alone and
 * picked up by a later run if it is still done.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { record as recordActivity } from "@/lib/activity";
import { wsBroadcast } from "@/lib/collab/server-broadcast";

const DEFAULT_AUTO_ARCHIVE_DAYS = 30;
/** Rows per run. A workspace with more stale done tasks than this is tidied over a few nights. */
const BATCH = 500;

export interface AutoArchiveResult {
  days: number;
  scanned: number;
  archived: number;
  /** Rows that changed between the read and the guarded write; retried next run. */
  skipped: number;
}

function resolveDays(env = process.env.TASKS_AUTO_ARCHIVE_DAYS): number {
  const n = Number(env);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_AUTO_ARCHIVE_DAYS;
}

interface StaleRow {
  id: string;
  workspace_id: string;
  title: string;
  kind: string;
  updated_at: string;
}

export async function archiveStaleDoneTasks(
  client: SupabaseClient = getSupabaseAdmin(),
  opts: { days?: number; now?: Date } = {},
): Promise<AutoArchiveResult> {
  const days = opts.days ?? resolveDays();
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();

  const { data, error } = await client
    .from("nodes")
    .select("id, workspace_id, title, kind, updated_at")
    .in("kind", ["task", "bug"])
    .eq("status", "done")
    .lt("updated_at", cutoff)
    .order("updated_at", { ascending: true })
    .limit(BATCH);
  if (error) throw new Error(`auto-archive: listing stale done tasks failed: ${error.message}`);
  const rows = (data ?? []) as StaleRow[];
  const result: AutoArchiveResult = { days, scanned: rows.length, archived: 0, skipped: 0 };
  if (rows.length === 0) return result;

  // Activity entries are keyed by workspace slug, not id.
  const workspaceIds = [...new Set(rows.map((row) => row.workspace_id))];
  const { data: workspaces, error: wsError } = await client
    .from("workspaces")
    .select("id, slug")
    .in("id", workspaceIds);
  if (wsError) throw new Error(`auto-archive: reading workspaces failed: ${wsError.message}`);
  const slugById = new Map((workspaces ?? []).map((ws) => [ws.id as string, ws.slug as string]));

  for (const row of rows) {
    // Guarded by the updated_at we read: a task touched since is not ours to archive.
    const { data: updated, error: updateError } = await client
      .from("nodes")
      .update({ status: "archived" })
      .eq("id", row.id)
      .eq("workspace_id", row.workspace_id)
      .eq("status", "done")
      .eq("updated_at", row.updated_at)
      .select("id");
    if (updateError) throw new Error(`auto-archive: archiving ${row.id} failed: ${updateError.message}`);
    if (!updated || updated.length === 0) {
      result.skipped += 1;
      continue;
    }
    result.archived += 1;
    const slug = slugById.get(row.workspace_id);
    if (slug) {
      recordActivity(slug, "update", row.id, row.title, `archived automatically: done for ${days} days`, {
        actorKind: "system",
        payload: { via: "worker", node_kind: row.kind, auto_archive_days: days, source: "worker" },
      });
    }
    await wsBroadcast.nodeUpdated(row.workspace_id, row.id, undefined, { status: "archived" });
  }
  return result;
}
