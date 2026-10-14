/**
 * DELETE /api/capability-grants/:id?workspace_id=… — revoke one grant.
 * Session-cookie owner|admin (`capabilityAdmin`). Soft: `revoked_at` is set
 * and the row stays for the audit trail; an already-revoked grant is 404.
 */
import { z } from "zod";
import { withRoute } from "@/lib/route";
import { capabilityAdmin } from "@/lib/capabilities/admin";
import { appendAudit } from "@/lib/audit";

export const DELETE = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const workspaceId = new URL(req.url).searchParams.get("workspace_id");
  if (
    !workspaceId ||
    !z.string().uuid().safeParse(workspaceId).success ||
    !z.string().uuid().safeParse(id).success
  ) {
    return Response.json(
      { error: "invalid_request", message: "valid grant id and workspace_id are required" },
      { status: 400 },
    );
  }
  const auth = await capabilityAdmin(req, workspaceId);
  if (auth instanceof Response) return auth;
  const { data, error } = await auth.supabase
    .from("capability_grants")
    .update({ revoked_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .is("revoked_at", null)
    .select("id,revoked_at")
    .maybeSingle();
  if (error) return Response.json({ error: "grant_revoke_failed", message: error.message }, { status: 500 });
  if (!data) return Response.json({ error: "grant_not_found" }, { status: 404 });
  void appendAudit({
    workspaceId,
    actorType: "user",
    actorId: auth.userId,
    action: "capability.grant.revoke",
    targetType: "capability_grant",
    targetId: id,
  });
  return Response.json({ grant: data });
});
