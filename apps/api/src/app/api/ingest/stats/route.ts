/**
 * GET /api/ingest/stats?workspace_id=<uuid>
 *
 * Aggregate counts for the Ingesta page: connector_jobs by status (the
 * "queue") and ingest_candidates by status (the "NEXO/review" columns).
 * Real numbers, not per-signal simulation: a fully per-signal traced view
 * would need a connector_jobs <-> ingest_candidates link that does not
 * exist yet.
 */
import { z } from "zod";
import { openWorkspaceById } from "@/lib/auth/workspace";
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

const QuerySchema = z.object({ workspace_id: z.string().uuid() });

const JOB_STATUSES = ["queued", "running", "done", "failed", "dead"] as const;
const CANDIDATE_STATUSES = ["pending", "reprocess", "accepted", "dismissed"] as const;

export const GET = withRoute(async (req: Request) => {
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({ workspace_id: url.searchParams.get("workspace_id") });
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const ctx = await openWorkspaceById(req, parsed.data.workspace_id, "read");
  if (ctx instanceof Response) return ctx;
  const { storage } = ctx;

  if (storage.backend !== "supabase") {
    return Response.json({
      jobs: Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])),
      candidates: Object.fromEntries(CANDIDATE_STATUSES.map((s) => [s, 0])),
      running_started_at: [],
    });
  }

  const sb = getSupabaseAdmin();
  const [jobRows, candidateRows] = await Promise.all([
    sb.from("connector_jobs").select("status, started_at").eq("workspace_id", parsed.data.workspace_id),
    sb.from("ingest_candidates").select("status").eq("workspace_id", parsed.data.workspace_id),
  ]);

  const jobs = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<string, number>;
  // Backwards-compatible addition (2026-07-21): `started_at` of each
  // `running` job, so the UI can tell a live run from one stuck in
  // `running` forever (stale-run guard in the NEXO processing box).
  const runningStartedAt: (string | null)[] = [];
  for (const row of jobRows.data ?? []) {
    if (row.status in jobs) jobs[row.status] = (jobs[row.status] ?? 0) + 1;
    if (row.status === "running") runningStartedAt.push((row.started_at as string | null) ?? null);
  }

  const candidates = Object.fromEntries(CANDIDATE_STATUSES.map((s) => [s, 0])) as Record<string, number>;
  for (const row of candidateRows.data ?? []) {
    if (row.status in candidates) candidates[row.status] = (candidates[row.status] ?? 0) + 1;
  }

  return Response.json({ jobs, candidates, running_started_at: runningStartedAt });
});
