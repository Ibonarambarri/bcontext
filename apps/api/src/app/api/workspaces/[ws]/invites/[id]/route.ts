/**
 * DELETE /api/workspaces/:ws/invites/:id — revoke a pending invitation.
 *
 * Scoped to the workspace's organisation: an id from another tenant deletes
 * nothing, and says nothing.
 */
import { openWorkspace } from "@/lib/auth/workspace";
import { withRoute } from "@/lib/route";
import { revokeInvite } from "@/lib/workspaces/orgs";

export const DELETE = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ ws: string; id: string }> },
) => {
  const { ws, id } = await params;
  const ctx = await openWorkspace(req, ws, "admin");
  if (ctx instanceof Response) return ctx;
  if (ctx.actor.kind !== "user") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (ctx.storage.backend !== "supabase") {
    return Response.json(
      { error: "unsupported", message: "Invitations need Supabase." },
      { status: 400 },
    );
  }
  await revokeInvite(ctx.storage.workspace.organization_id, id);
  return Response.json({ ok: true });
});
