/**
 * Per-install live state for the Integrations hub (the "in progress" aura).
 *
 * Pure derivation from three tables so the route stays thin and the
 * mapping is unit-testable: connector_installs (status, config), the
 * install's connector_jobs (running / queued-due), and ingest_candidates
 * created recently for the install's source.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  PROCESSING_WINDOW_MS,
  type IntegrationActivity,
  type IntegrationActivityState,
} from "@bcontext-dev/contract/connectors/activity";

export interface ActivityInstallRow {
  id: string;
  connector_id: string;
  status: string;
  last_sync_at: string | null;
  config: Record<string, unknown>;
}

export interface ActivityJobRow {
  install_id: string | null;
  status: string;
  next_attempt_at: string | null;
  payload?: Record<string, unknown> | null;
}

export interface ActivityCandidateRow {
  source: string;
  created_at: string;
}

const DAY_MS = 24 * 60 * 60_000;

export function deriveActivity(
  installs: ActivityInstallRow[],
  jobs: ActivityJobRow[],
  candidates: ActivityCandidateRow[],
  now = new Date(),
): IntegrationActivity[] {
  const nowMs = now.getTime();
  return installs.map((install) => {
    const mine = jobs.filter((j) => j.install_id === install.id);
    const running = mine.filter((j) => j.status === "running").length;
    const queued = mine.filter(
      (j) =>
        (j.status === "queued" || j.status === "failed") &&
        (!j.next_attempt_at || new Date(j.next_attempt_at).getTime() <= nowMs),
    ).length;
    const extracting = mine.some((j) => j.status === "running" && j.payload?.phase === "extract");

    const recent = candidates.filter(
      (c) => c.source === install.connector_id && nowMs - new Date(c.created_at).getTime() <= PROCESSING_WINDOW_MS,
    ).length;
    const today = candidates.filter(
      (c) => c.source === install.connector_id && nowMs - new Date(c.created_at).getTime() <= DAY_MS,
    ).length;

    const stats = (install.config.last_run_stats as Record<string, unknown> | undefined) ?? null;
    const statsAt = typeof stats?.at === "string" ? new Date(stats.at).getTime() : NaN;
    const signalsToday =
      stats && Number.isFinite(statsAt) && nowMs - statsAt <= DAY_MS && typeof stats.signals === "number"
        ? stats.signals
        : 0;

    let state: IntegrationActivityState = "idle";
    if (install.status === "errored") state = "error";
    else if (extracting || recent > 0) state = "processing";
    else if (running > 0 || queued > 0) state = "fetching";

    return {
      connector_id: install.connector_id,
      install_id: install.id,
      state,
      running_jobs: running,
      queued_jobs: queued,
      last_run_at: install.last_sync_at,
      next_run_at: typeof install.config.next_run_at === "string" ? install.config.next_run_at : null,
      signals_today: signalsToday,
      candidates_today: today,
    };
  });
}

export async function loadActivity(admin: SupabaseClient, workspaceId: string, now = new Date()): Promise<IntegrationActivity[]> {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const [installs, jobs, candidates] = await Promise.all([
    admin
      .from("connector_installs")
      .select("id, connector_id, status, last_sync_at, config")
      .eq("workspace_id", workspaceId)
      .neq("status", "uninstalled"),
    admin
      .from("connector_jobs")
      .select("install_id, status, next_attempt_at, payload")
      .eq("workspace_id", workspaceId)
      .in("status", ["queued", "running", "failed"]),
    admin
      .from("ingest_candidates")
      .select("source, created_at")
      .eq("workspace_id", workspaceId)
      .gte("created_at", since),
  ]);
  return deriveActivity(
    (installs.data ?? []) as ActivityInstallRow[],
    (jobs.data ?? []) as ActivityJobRow[],
    (candidates.data ?? []) as ActivityCandidateRow[],
    now,
  );
}
