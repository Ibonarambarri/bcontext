/**
 * GET /api/webhooks/deliveries?workspace=<slug>&status=<filter>
 *
 * Lists recent webhook_deliveries rows for the given workspace, scoped to
 * what RLS allows (admin/owner only). Optional `?status=dead` filter
 * powers the DLQ view in settings.
 */
import { openWorkspace } from "@/lib/auth/workspace";
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

const ALLOWED_STATUS = new Set([
  "pending",
  "retrying",
  "sent",
  "failed",
  "dead",
]);

export const GET = withRoute(async (req: Request) => {
  const ws = new URL(req.url).searchParams.get("workspace");
  const ctx = await openWorkspace(req, ws, "read", { scope: null });
  if (ctx instanceof Response) return ctx;
  const { storage } = ctx;
  if (storage.backend !== "supabase") {
    return Response.json({ deliveries: [] });
  }

  const statusFilter = new URL(req.url).searchParams.get("status");
  const limit = Math.min(
    Number(new URL(req.url).searchParams.get("limit") ?? 50),
    200,
  );

  const sb = getSupabaseAdmin();
  let query = sb
    .from("webhook_deliveries")
    .select(
      "id, endpoint_id, event_type, status, attempts, last_error, next_retry_at, created_at, updated_at",
    )
    .eq("workspace_id", storage.workspace.id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (statusFilter && ALLOWED_STATUS.has(statusFilter)) {
    query = query.eq("status", statusFilter);
  }
  const { data, error } = await query;
  if (error) {
    return Response.json(
      { error: "query_failed", message: error.message },
      { status: 500 },
    );
  }
  return Response.json({ deliveries: data ?? [] });
});
