/**
 * Connector job worker.
 *
 * Drains `connector_jobs` rows that are due (status IN ('queued','failed')
 * AND next_attempt_at <= now()) by handing each off to `runJob`. Mirrors
 * the webhook worker shape so both drains share scheduling + monitoring.
 *
 * Wire-up: invoked by the pg-boss job `connector.drain`
 * (`src/lib/queue/handlers.ts`) on a 60-second cadence. Returns the batch
 * outcome for the job log.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { runJob } from "./runtime";
import { log } from "@bcontext-dev/contract/log";

export interface WorkerResult {
  picked: number;
  done: number;
  failed: number;
  dead: number;
}

export async function processConnectorJobs(
  admin: SupabaseClient,
  opts: { batchSize?: number; now?: Date } = {},
): Promise<WorkerResult> {
  const batchSize = opts.batchSize ?? 10;
  const now = (opts.now ?? new Date()).toISOString();

  const { data, error } = await admin
    .from("connector_jobs")
    .select("id, status")
    .in("status", ["queued", "failed"])
    .lte("next_attempt_at", now)
    .order("next_attempt_at", { ascending: true })
    .limit(batchSize);

  if (error) {
    log.warn("connector.worker.pickup_failed", { error: error.message });
    return { picked: 0, done: 0, failed: 0, dead: 0 };
  }
  const rows = (data ?? []) as Array<{ id: string; status: string }>;
  if (rows.length === 0) return { picked: 0, done: 0, failed: 0, dead: 0 };

  let done = 0;
  let failed = 0;
  let dead = 0;

  for (const row of rows) {
    // CAS lock: only proceed if status still matches the row we picked.
    const locked = await admin
      .from("connector_jobs")
      .update({ status: "running", started_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", row.status)
      .select("id")
      .maybeSingle();
    if (!locked.data) continue;

    const result = await runJob(row.id);
    if (result.status === "done") done++;
    else if (result.status === "dead") dead++;
    else failed++;
  }

  log.info("connector.worker.drained", {
    picked: rows.length,
    done,
    failed,
    dead,
  });

  return { picked: rows.length, done, failed, dead };
}
