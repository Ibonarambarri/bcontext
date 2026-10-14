/**
 * Cadence scheduler — turns `connector_installs.config.cadence` into real
 * runs. Every minute the pg-boss job `connector.schedule` looks for active
 * installs whose `config.next_run_at` is due, enqueues one `full_sync`
 * job for each and advances `next_run_at` with the contract's
 * `computeNextRun`. Installs with a cadence but no `next_run_at` yet get one
 * on the first pass (so the first run happens at the next slot, not now).
 *
 * Idempotent by construction: the advance is written before the job is
 * enqueued, and a due install with a job already queued/running is skipped.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { CadenceSchema, computeNextRun } from "@bcontext-dev/contract/connectors/cadence";
import { log } from "@bcontext-dev/contract/log";
import { enqueueFullSync } from "./runtime";

export interface SchedulerResult {
  scanned: number;
  initialised: number;
  enqueued: number;
  skipped: number;
}

interface InstallRow {
  id: string;
  workspace_id: string;
  connector_id: string;
  config: Record<string, unknown>;
}

export function nextRunFromConfig(config: Record<string, unknown>, now: Date): Date | null {
  const parsed = CadenceSchema.safeParse(config.cadence);
  if (!parsed.success) return null;
  return computeNextRun(parsed.data, now);
}

export async function scheduleDueSyncs(
  admin: SupabaseClient,
  opts: { now?: Date; batchSize?: number } = {},
): Promise<SchedulerResult> {
  const now = opts.now ?? new Date();
  const result: SchedulerResult = { scanned: 0, initialised: 0, enqueued: 0, skipped: 0 };

  const { data, error } = await admin
    .from("connector_installs")
    .select("id, workspace_id, connector_id, config")
    .eq("status", "active")
    .not("config->cadence", "is", null)
    .limit(opts.batchSize ?? 200);
  if (error) {
    log.warn("connector.scheduler.scan_failed", { error: error.message });
    return result;
  }

  for (const row of (data ?? []) as InstallRow[]) {
    result.scanned += 1;
    const config = row.config ?? {};
    const next = nextRunFromConfig(config, now);
    if (!next) {
      result.skipped += 1;
      continue;
    }
    const due = typeof config.next_run_at === "string" ? new Date(config.next_run_at) : null;

    if (!due || Number.isNaN(due.getTime())) {
      await admin
        .from("connector_installs")
        .update({ config: { ...config, next_run_at: next.toISOString() } })
        .eq("workspace_id", row.workspace_id)
        .eq("id", row.id);
      result.initialised += 1;
      continue;
    }
    if (due > now) {
      result.skipped += 1;
      continue;
    }

    // Advance first (CAS on the old value) so two runners cannot both fire.
    const advanced = await admin
      .from("connector_installs")
      .update({ config: { ...config, next_run_at: next.toISOString() } })
      .eq("workspace_id", row.workspace_id)
      .eq("id", row.id)
      .eq("config->>next_run_at", config.next_run_at as string)
      .select("id")
      .maybeSingle();
    if (!advanced.data) {
      result.skipped += 1;
      continue;
    }

    const { count } = await admin
      .from("connector_jobs")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", row.workspace_id)
      .eq("install_id", row.id)
      .in("status", ["queued", "running"]);
    if ((count ?? 0) > 0) {
      result.skipped += 1;
      continue;
    }

    await enqueueFullSync({
      workspaceId: row.workspace_id,
      connectorId: row.connector_id,
      installId: row.id,
      cursor: null,
    });
    result.enqueued += 1;
    log.info("connector.scheduler.enqueued", {
      workspace_id: row.workspace_id,
      connector: row.connector_id,
      next_run_at: next.toISOString(),
    });
  }
  return result;
}
