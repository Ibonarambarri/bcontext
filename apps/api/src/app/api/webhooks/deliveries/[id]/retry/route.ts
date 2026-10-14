/**
 * POST /api/webhooks/deliveries/[id]/retry
 *
 * Requeues a dead (or otherwise stuck) delivery by flipping it back to
 * status='pending' with next_retry_at=now() and attempts reset. The next
 * run of the worker's `webhook.drain` job picks it up.
 */
import { gate, requireWorkspaceMember } from "@/lib/auth/require";
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export const POST = withRoute(async (req: Request, ctx: RouteCtx) => {
  const gated = await gate(req);
  if (gated instanceof Response) return gated;
  if (gated.kind !== "user") {
    return Response.json(
      { error: "user_session_required" },
      { status: 403 },
    );
  }
  const { id } = await ctx.params;

  const sb = getSupabaseAdmin();
  // Resolve the delivery's workspace first — the admin client bypasses
  // RLS, so membership must be verified before the requeue write.
  const { data: existing } = await sb
    .from("webhook_deliveries")
    .select("id, workspace_id")
    .eq("id", id)
    .maybeSingle();
  if (!existing) {
    return Response.json(
      { error: "delivery_not_found" },
      { status: 404 },
    );
  }
  const denied = await requireWorkspaceMember(gated, {
    backend: "supabase",
    workspace: { id: existing.workspace_id as string },
  });
  if (denied) return denied;

  const { data, error } = await sb
    .from("webhook_deliveries")
    .update({
      status: "pending",
      attempts: 0,
      last_error: null,
      next_retry_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("id, workspace_id")
    .maybeSingle();
  if (error || !data) {
    return Response.json(
      { error: "delivery_not_found" },
      { status: 404 },
    );
  }
  return Response.json({ ok: true, id });
});
