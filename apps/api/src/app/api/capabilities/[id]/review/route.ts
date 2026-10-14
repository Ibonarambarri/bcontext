/**
 * Approve or reject a capability, with a reviewer and a written trail.
 *
 *   POST /api/capabilities/:id/review   { workspace_id, decision, comment? }
 *   GET  /api/capabilities/:id/review?workspace_id=…   the review history
 *
 * Session-cookie owner|admin (`capabilityAdmin`). See the POST's JSDoc for
 * how it differs from the plain status PATCH on `/api/capabilities`.
 */
import { z } from "zod";
import { appendAudit } from "@/lib/audit";
import { capabilityAdmin, capabilityCredentialUsable, parseJson } from "@/lib/capabilities/admin";
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

const ParamsSchema = z.object({ id: z.string().uuid() });

const ReviewInputSchema = z.object({
  workspace_id: z.string().uuid(),
  decision: z.enum(["approved", "rejected"]),
  comment: z.string().max(2000).default(""),
});

/**
 * Explicit approve/reject review, distinct from the generic status PATCH:
 * it requires a reviewer, records a comment, and writes an immutable row to
 * `capability_reviews` before flipping status. Approving still requires a
 * usable credential for executable types (same gate as the status PATCH).
 * Rejecting always returns the capability to `draft` so it can be revised
 * and resubmitted.
 */
export const POST = withRoute(async (
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) => {
  const params = ParamsSchema.safeParse(await ctx.params);
  if (!params.success) return Response.json({ error: "invalid_provider_id" }, { status: 400 });
  const input = await parseJson(req, ReviewInputSchema);
  if (input instanceof Response) return input;
  const auth = await capabilityAdmin(req, input.workspace_id);
  if (auth instanceof Response) return auth;

  const admin = getSupabaseAdmin();
  const { data: current } = await admin
    .from("capabilities")
    .select("id,type,current_version_id,deleted_at")
    .eq("workspace_id", input.workspace_id)
    .eq("id", params.data.id)
    .maybeSingle();
  if (!current || current.deleted_at) {
    return Response.json({ error: "capability_not_found" }, { status: 404 });
  }

  if (input.decision === "approved" && ["mcp_server", "api", "workflow"].includes(current.type)) {
    const credentialUsable = await capabilityCredentialUsable(input.workspace_id, params.data.id);
    if (!credentialUsable) {
      return Response.json({
        error: "provider_reconnect_required",
        message: "Reconnect this provider before approving it.",
      }, { status: 409 });
    }
  }

  const nextStatus = input.decision === "approved" ? "approved" : "draft";
  const { data: updated, error: updateError } = await admin
    .from("capabilities")
    .update({ status: nextStatus, disabled_at: null })
    .eq("workspace_id", input.workspace_id)
    .eq("id", params.data.id)
    .is("deleted_at", null)
    .select("*")
    .single();
  if (updateError || !updated) {
    const usedByBundle = updateError?.message.includes("capability_provider_used_by_bundle");
    return Response.json({
      error: usedByBundle ? "provider_used_by_bundle" : "catalog_update_failed",
      message: usedByBundle ? "This provider is pinned by a current bundle." : updateError?.message ?? "not found",
    }, { status: usedByBundle ? 409 : 404 });
  }

  const { data: review, error: reviewError } = await admin
    .from("capability_reviews")
    .insert({
      workspace_id: input.workspace_id,
      capability_id: params.data.id,
      version_id: current.current_version_id,
      reviewer_user_id: auth.userId,
      decision: input.decision,
      comment: input.comment,
    })
    .select("id,decision,comment,created_at")
    .single();
  if (reviewError || !review) {
    return Response.json({ error: "review_write_failed", message: reviewError?.message ?? "no row" }, { status: 500 });
  }

  void appendAudit({
    workspaceId: input.workspace_id,
    actorType: "user",
    actorId: auth.userId,
    action: "capability.review",
    targetType: "capability",
    targetId: params.data.id,
    input: { decision: input.decision, comment: input.comment },
    output: { review_id: review.id, status: nextStatus },
  });

  return Response.json({ capability: updated, review });
});

export const GET = withRoute(async (
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) => {
  const params = ParamsSchema.safeParse(await ctx.params);
  const workspaceId = new URL(req.url).searchParams.get("workspace_id");
  if (!params.success || !workspaceId || !z.string().uuid().safeParse(workspaceId).success) {
    return Response.json({ error: "invalid_request", message: "valid provider and workspace ids are required" }, { status: 400 });
  }
  const auth = await capabilityAdmin(req, workspaceId);
  if (auth instanceof Response) return auth;
  const { data, error } = await auth.supabase
    .from("capability_reviews")
    .select("id,version_id,reviewer_user_id,decision,comment,created_at")
    .eq("workspace_id", workspaceId)
    .eq("capability_id", params.data.id)
    .order("created_at", { ascending: false });
  if (error) return Response.json({ error: "internal", message: error.message }, { status: 500 });
  return Response.json({ reviews: data ?? [] });
});
