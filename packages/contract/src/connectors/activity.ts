/**
 * Per-install live state for the Integrations hub — what powers the
 * "in progress" aura on a connected integration.
 *
 *   fetching    a connector_job for the install is running, or queued and due
 *   processing  NEXO is extracting from what was fetched (the running job is
 *               in its extract phase, or candidates for the install were
 *               created in the last two minutes)
 *   error       the install is `errored`
 *   idle        none of the above
 */
export type IntegrationActivityState = "idle" | "fetching" | "processing" | "error";

export interface IntegrationActivity {
  connector_id: string;
  install_id: string;
  state: IntegrationActivityState;
  running_jobs: number;
  queued_jobs: number;
  last_run_at: string | null;
  next_run_at: string | null;
  /** Items fetched in the last 24 h (best effort, from job payload stats). */
  signals_today: number;
  candidates_today: number;
}

/** Window after a candidate lands in which the install still reads as "processing". */
export const PROCESSING_WINDOW_MS = 2 * 60_000;
